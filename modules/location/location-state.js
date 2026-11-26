/**
 * Persistent location session state management and live Chrome session revalidation.
 */

export const LOCATION_STATES = Object.freeze({
  NOT_CONFIGURED: "Not configured",
  CONFIGURED: "Configured",
  GPS_APPLIED: "GPS applied",
  GPS_VERIFIED: "GPS verified",
  PERMISSION_DENIED: "Permission denied",
  LOCATION_MISMATCH: "Location mismatch",
  DEBUGGER_DETACHED: "Debugger detached",
  VERIFICATION_FAILED: "Verification failed",
});

export const GOOGLE_LOCATION_STATUSES = Object.freeze({
  UNVERIFIED: "Unverified",
});

export const LOCATION_STORAGE_KEY = "dm_location_session";

export function createDefaultLocationState() {
  return {
    state: LOCATION_STATES.NOT_CONFIGURED,
    config: null,
    tabId: null,
    tabUrl: null,
    debuggerAttached: false,
    permissionStatus: "unknown",
    reportedCoords: null,
    latitudeDelta: null,
    longitudeDelta: null,
    lastVerifiedAt: null,
    lastError: null,
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
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
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
  };
}

export async function saveLocationState(storageClient, nextState) {
  const normalized = {
    ...createDefaultLocationState(),
    ...nextState,
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
  };
  await storageClient.set({ [LOCATION_STORAGE_KEY]: normalized });
  return normalized;
}

/**
 * Revalidate persisted session state against live Chrome tabs & debugger targets.
 * Never assumes a stored override is still active after reload or restart.
 */
export async function revalidateLocationSession({ state, chromeApi }) {
  if (!state) {
    return createDefaultLocationState();
  }

  if (state.tabId === null || state.tabId === undefined) {
    const baseState = state.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED;
    return {
      ...state,
      debuggerAttached: false,
      state:
        state.state === LOCATION_STATES.DEBUGGER_DETACHED ||
        state.state === LOCATION_STATES.PERMISSION_DENIED ||
        state.state === LOCATION_STATES.VERIFICATION_FAILED
          ? state.state
          : baseState,
    };
  }

  let tabExists = false;
  let tabUrl = state.tabUrl;
  try {
    const tab = await chromeApi.tabs.get(state.tabId);
    if (tab && tab.id === state.tabId) {
      tabExists = true;
      tabUrl = tab.url || tabUrl;
    }
  } catch {
    tabExists = false;
  }

  if (!tabExists) {
    const wasActive = Boolean(state.debuggerAttached);
    return {
      ...state,
      tabId: null,
      tabUrl: null,
      debuggerAttached: false,
      state: wasActive
        ? LOCATION_STATES.DEBUGGER_DETACHED
        : state.config
          ? LOCATION_STATES.CONFIGURED
          : LOCATION_STATES.NOT_CONFIGURED,
      lastError: wasActive ? "Dedicated test tab was closed." : state.lastError,
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
    return {
      ...state,
      tabUrl,
      debuggerAttached: false,
      state: LOCATION_STATES.DEBUGGER_DETACHED,
      lastError: "Debugger session disconnected. Re-apply location to resume.",
    };
  }

  return {
    ...state,
    tabUrl,
    debuggerAttached: stillAttached,
  };
}

