/**
 * Persistent location & Google Search verification state management and live revalidation.
 */

export const LOCATION_STATES = Object.freeze({
  NOT_CONFIGURED: "Not configured",
  CONFIGURED: "Configured",
  GPS_APPLIED: "GPS applied",
  GPS_VERIFIED: "GPS verified",
  GOOGLE_MATCHED: "Google location matched",
  GOOGLE_MISMATCH: "Google location mismatch",
  GOOGLE_UNAVAILABLE: "Google location unavailable",
  PERMISSION_DENIED: "Permission denied",
  LOCATION_MISMATCH: "Location mismatch",
  DEBUGGER_DISCONNECTED: "Debugger disconnected",
  SEARCH_BLOCKED: "Search blocked",
  VERIFICATION_FAILED: "Verification failed",
});

export const GOOGLE_LOCATION_STATUSES = Object.freeze({
  UNVERIFIED: "Unverified",
  MATCHED: "Google location matched",
  MISMATCH: "Google location mismatch",
  UNAVAILABLE: "Google location unavailable",
  SEARCH_BLOCKED: "Search blocked",
  DEBUGGER_DISCONNECTED: "Debugger disconnected",
  VERIFICATION_FAILED: "Verification failed",
});

export const LOCATION_STORAGE_KEY = "dm_location_session";

export function createDefaultLocationState() {
  return {
    state: LOCATION_STATES.NOT_CONFIGURED,
    browserGpsStatus: LOCATION_STATES.NOT_CONFIGURED,
    config: null,
    tabId: null,
    tabUrl: null,
    debuggerAttached: false,
    permissionStatus: "unknown",
    reportedCoords: null,
    latitudeDelta: null,
    longitudeDelta: null,
    lastVerifiedAt: null,
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    googleDetectedLocation: null,
    googleLocationSource: null,
    googleLocationSourceType: null,
    googleLastVerifiedAt: null,
    googleVerificationEvidence: null,
    lastError: null,
    warningMessage: null,
  };
}

export function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url).trim());
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return String(url).trim();
  }
}

export function hasConfigChanged(prevConfig, nextConfig) {
  if (!prevConfig || !nextConfig) return true;
  const keys = [
    "locationName",
    "latitude",
    "longitude",
    "accuracy",
    "targetCity",
    "country",
    "language",
    "googleDomain",
    "testPageUrl",
  ];
  return keys.some((key) => String(prevConfig[key] ?? "") !== String(nextConfig[key] ?? ""));
}

export function clearVerificationFields(state, { preserveTab = true } = {}) {
  return {
    ...state,
    browserGpsStatus: state.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
    tabId: preserveTab ? state.tabId : null,
    tabUrl: preserveTab ? state.tabUrl : null,
    debuggerAttached: preserveTab ? state.debuggerAttached : false,
    permissionStatus: "unknown",
    reportedCoords: null,
    latitudeDelta: null,
    longitudeDelta: null,
    lastVerifiedAt: null,
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    googleDetectedLocation: null,
    googleLocationSource: null,
    googleLocationSourceType: null,
    googleLastVerifiedAt: null,
    googleVerificationEvidence: null,
    lastError: null,
    warningMessage: null,
  };
}

export async function loadLocationState(storageClient) {
  const result = await storageClient.get(LOCATION_STORAGE_KEY);
  const saved = result?.[LOCATION_STORAGE_KEY];
  if (!saved || typeof saved !== "object") {
    return createDefaultLocationState();
  }
  return {
    ...createDefaultLocationState(),
    ...saved,
  };
}

export async function saveLocationState(storageClient, nextState) {
  const normalized = {
    ...createDefaultLocationState(),
    ...nextState,
  };
  await storageClient.set({ [LOCATION_STORAGE_KEY]: normalized });
  return normalized;
}

/**
 * Revalidate persisted session state against live Chrome tabs & debugger targets.
 * Optionally re-verifies live browser GPS coordinates when the debugger is still attached.
 */
export async function revalidateLocationSession({
  state,
  chromeApi,
  reverifyGpsFn = null,
}) {
  if (!state) {
    return createDefaultLocationState();
  }

  if (state.tabId === null || state.tabId === undefined) {
    const baseState = state.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED;
    const isTerminalStatus =
      state.state === LOCATION_STATES.DEBUGGER_DISCONNECTED ||
      state.state === LOCATION_STATES.PERMISSION_DENIED ||
      state.state === LOCATION_STATES.VERIFICATION_FAILED ||
      state.state === LOCATION_STATES.SEARCH_BLOCKED;

    return {
      ...state,
      debuggerAttached: false,
      browserGpsStatus: isTerminalStatus ? state.browserGpsStatus : baseState,
      state: isTerminalStatus ? state.state : baseState,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    };
  }

  let tabExists = false;
  let liveTabUrl = state.tabUrl;
  try {
    const tab = await chromeApi.tabs.get(state.tabId);
    if (tab && tab.id === state.tabId) {
      tabExists = true;
      liveTabUrl = tab.url || liveTabUrl;
    }
  } catch {
    tabExists = false;
  }

  if (!tabExists) {
    const wasActive = Boolean(state.debuggerAttached);
    const cleared = clearVerificationFields(state, { preserveTab: false });
    return {
      ...cleared,
      browserGpsStatus: wasActive
        ? LOCATION_STATES.DEBUGGER_DISCONNECTED
        : state.config
          ? LOCATION_STATES.CONFIGURED
          : LOCATION_STATES.NOT_CONFIGURED,
      state: wasActive
        ? LOCATION_STATES.DEBUGGER_DISCONNECTED
        : state.config
          ? LOCATION_STATES.CONFIGURED
          : LOCATION_STATES.NOT_CONFIGURED,
      lastError: wasActive ? "Dedicated tab was closed." : state.lastError,
    };
  }

  let stillAttached = Boolean(state.debuggerAttached);
  if (typeof chromeApi?.debugger?.getTargets === "function") {
    try {
      const targets = await chromeApi.debugger.getTargets();
      const target = targets.find((t) => t.tabId === state.tabId);
      stillAttached = Boolean(target?.attached);
    } catch {
      stillAttached = false;
    }
  }

  if (state.debuggerAttached && !stillAttached) {
    const cleared = clearVerificationFields(
      { ...state, tabUrl: liveTabUrl, debuggerAttached: false },
      { preserveTab: true }
    );
    return {
      ...cleared,
      browserGpsStatus: LOCATION_STATES.DEBUGGER_DISCONNECTED,
      state: LOCATION_STATES.DEBUGGER_DISCONNECTED,
      lastError: "Debugger disconnected. Re-apply location to resume.",
    };
  }

  // If the tab URL navigated away from the URL recorded during Google verification, invalidate Google verification.
  let nextState = { ...state, tabUrl: liveTabUrl, debuggerAttached: stillAttached };
  if (
    nextState.googleVerificationEvidence?.pageUrl &&
    liveTabUrl &&
    normalizeUrlForComparison(liveTabUrl) !==
    normalizeUrlForComparison(nextState.googleVerificationEvidence.pageUrl)
  ) {
    nextState = {
      ...nextState,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
      googleDetectedLocation: null,
      googleLocationSource: null,
      googleLocationSourceType: null,
      googleLastVerifiedAt: null,
      googleVerificationEvidence: null,
      warningMessage: "Tab URL changed; previous Google location verification was invalidated.",
    };
  }

  // Reverify actual GPS coordinates when restoring an attached session.
  if (stillAttached && nextState.config && typeof reverifyGpsFn === "function") {
    const verification = await reverifyGpsFn({
      tabId: nextState.tabId,
      expectedLatitude: nextState.config.latitude,
      expectedLongitude: nextState.config.longitude,
      chromeApi,
    });
    const attachedAfterCheck = verification.state !== LOCATION_STATES.DEBUGGER_DISCONNECTED;
    nextState = {
      ...nextState,
      debuggerAttached: attachedAfterCheck,
      browserGpsStatus: verification.state,
      permissionStatus: verification.permissionStatus,
      reportedCoords: verification.reportedCoords,
      latitudeDelta: verification.latitudeDelta,
      longitudeDelta: verification.longitudeDelta,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastError: verification.lastError,
      state:
        verification.state === LOCATION_STATES.GPS_VERIFIED &&
          nextState.googleLocationStatus !== GOOGLE_LOCATION_STATUSES.UNVERIFIED
          ? nextState.googleLocationStatus
          : verification.state,
    };
  }

  return nextState;
}
