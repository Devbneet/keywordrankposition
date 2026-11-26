/**
 * Geolocation controller managing the dedicated tab, Chrome Debugger API,
 * Emulation.setGeolocationOverride, browser GPS verification, and Google Search location verification.
 */

import { DEFAULT_ACCURACY_METRES, validateLocationInput } from "./coordinate-validator.js";
import { verifyBrowserGeolocation } from "./geolocation-verifier.js";
import {
  buildGoogleLocationCheckUrl,
  verifyGoogleSearchLocation,
} from "./google-location-verifier.js";
import {
  clearVerificationFields,
  createDefaultLocationState,
  GOOGLE_LOCATION_STATUSES,
  hasConfigChanged,
  loadLocationState,
  LOCATION_STATES,
  normalizeUrlForComparison,
  revalidateLocationSession,
  saveLocationState,
} from "./location-state.js";

export const DEFAULT_TEST_PAGE_URL = "https://example.com/";
const DEBUGGER_PROTOCOL_VERSION = "1.3";

function isTabReady(tab) {
  return Boolean(tab && tab.status === "complete");
}

async function waitForTabLoad({ tabId, chromeApi, timeoutMs = 12000 }) {
  try {
    const current = await chromeApi.tabs.get(tabId);
    if (isTabReady(current)) {
      return;
    }
  } catch {
    return;
  }

  if (!chromeApi?.tabs?.onUpdated?.addListener) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    chromeApi.tabs.onUpdated.addListener(onUpdated);
  });
}

async function safeDetachDebugger({ tabId, chromeApi }) {
  if (tabId === null || tabId === undefined) {
    return;
  }
  try {
    await chromeApi.debugger.sendCommand({ tabId }, "Emulation.clearGeolocationOverride", {});
  } catch {
    // Ignore if already detached or tab closed.
  }
  try {
    await chromeApi.debugger.detach({ tabId });
  } catch {
    // Ignore if already detached or tab closed.
  }
}

export function createGeolocationController({ chromeApi = globalThis.chrome, storageClient }) {
  if (!storageClient) {
    throw new Error("storageClient is required for createGeolocationController.");
  }

  async function ensureDedicatedTab({ current, targetUrl }) {
    let tabId = current.tabId;
    let tabUrl = current.tabUrl;
    let tabAvailable = false;

    if (tabId !== null && tabId !== undefined) {
      try {
        const existing = await chromeApi.tabs.get(tabId);
        if (existing && existing.id === tabId) {
          tabAvailable = true;
          const existingUrl = existing.url || tabUrl || "";
          if (normalizeUrlForComparison(existingUrl) !== normalizeUrlForComparison(targetUrl)) {
            const updated = await chromeApi.tabs.update(tabId, { url: targetUrl, active: true });
            await waitForTabLoad({ tabId, chromeApi });
            tabUrl = updated?.url || targetUrl;
          } else {
            await chromeApi.tabs.update(tabId, { active: true });
            tabUrl = existingUrl || targetUrl;
          }
        }
      } catch {
        tabAvailable = false;
      }
    }

    if (!tabAvailable) {
      const created = await chromeApi.tabs.create({ url: targetUrl, active: true });
      tabId = created.id;
      tabUrl = created.url || targetUrl;
      await waitForTabLoad({ tabId, chromeApi });
    }

    return { tabId, tabUrl, reused: tabAvailable };
  }

  async function applyOverrideAndVerifyGps({ currentState, config, tabId, tabUrl }) {
    let working = await saveLocationState(storageClient, {
      ...currentState,
      state: LOCATION_STATES.CONFIGURED,
      browserGpsStatus: LOCATION_STATES.CONFIGURED,
      config,
      tabId,
      tabUrl,
      lastError: null,
      warningMessage: null,
    });

    if (!working.debuggerAttached) {
      try {
        await chromeApi.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const failedState = await saveLocationState(storageClient, {
          ...working,
          debuggerAttached: false,
          browserGpsStatus: LOCATION_STATES.VERIFICATION_FAILED,
          state: LOCATION_STATES.VERIFICATION_FAILED,
          lastError: `Debugger attach failed: ${msg}`,
        });
        return { ok: false, error: failedState.lastError, state: failedState };
      }
    }

    try {
      await chromeApi.debugger.sendCommand({ tabId }, "Emulation.setGeolocationOverride", {
        latitude: config.latitude,
        longitude: config.longitude,
        accuracy: config.accuracy,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const detached = /detach|target closed|not attached/i.test(msg);
      const failedState = await saveLocationState(storageClient, {
        ...working,
        debuggerAttached: false,
        browserGpsStatus: detached ? LOCATION_STATES.DEBUGGER_DISCONNECTED : LOCATION_STATES.VERIFICATION_FAILED,
        state: detached ? LOCATION_STATES.DEBUGGER_DISCONNECTED : LOCATION_STATES.VERIFICATION_FAILED,
        lastError: `Geolocation override failed: ${msg}`,
      });
      return { ok: false, error: failedState.lastError, state: failedState };
    }

    working = await saveLocationState(storageClient, {
      ...working,
      debuggerAttached: true,
      browserGpsStatus: LOCATION_STATES.GPS_APPLIED,
      state: LOCATION_STATES.GPS_APPLIED,
      lastError: null,
    });

    const verification = await verifyBrowserGeolocation({
      tabId,
      expectedLatitude: config.latitude,
      expectedLongitude: config.longitude,
      chromeApi,
    });

    const stillAttached = verification.state !== LOCATION_STATES.DEBUGGER_DISCONNECTED;
    const finalState = await saveLocationState(storageClient, {
      ...working,
      debuggerAttached: stillAttached,
      browserGpsStatus: verification.state,
      state: verification.state,
      permissionStatus: verification.permissionStatus,
      reportedCoords: verification.reportedCoords,
      latitudeDelta: verification.latitudeDelta,
      longitudeDelta: verification.longitudeDelta,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastError: verification.lastError,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
      googleDetectedLocation: null,
      googleLocationSource: null,
      googleLocationSourceType: null,
      googleLastVerifiedAt: null,
      googleVerificationEvidence: null,
    });

    return {
      ok: finalState.browserGpsStatus === LOCATION_STATES.GPS_VERIFIED,
      state: finalState,
      limitationNote: verification.limitationNote,
    };
  }

  async function getStatus({ reverifyGps = true } = {}) {
    const stored = await loadLocationState(storageClient);
    const revalidated = await revalidateLocationSession({
      state: stored,
      chromeApi,
      reverifyGpsFn: reverifyGps ? verifyBrowserGeolocation : null,
    });
    if (JSON.stringify(revalidated) !== JSON.stringify(stored)) {
      await saveLocationState(storageClient, revalidated);
    }
    return revalidated;
  }

  async function openTestTab({ testPageUrl } = {}) {
    const current = await getStatus({ reverifyGps: false });
    const targetUrl =
      String(testPageUrl || current.config?.testPageUrl || DEFAULT_TEST_PAGE_URL).trim() ||
      DEFAULT_TEST_PAGE_URL;

    const urlChanged =
      current.tabUrl &&
      normalizeUrlForComparison(current.tabUrl) !== normalizeUrlForComparison(targetUrl);

    const { tabId, tabUrl, reused } = await ensureDedicatedTab({ current, targetUrl });

    const baseState = urlChanged
      ? clearVerificationFields(current, { preserveTab: true })
      : current;

    const nextState = await saveLocationState(storageClient, {
      ...baseState,
      tabId,
      tabUrl,
      state: current.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
      lastError: null,
    });

    return { ok: true, reused, state: nextState };
  }

  async function applyLocation(input = {}) {
    const validation = validateLocationInput(input);
    if (!validation.valid) {
      return {
        ok: false,
        errors: validation.errors,
        state: await getStatus({ reverifyGps: false }),
      };
    }

    const config = validation.value;
    const targetUrl = config.testPageUrl || DEFAULT_TEST_PAGE_URL;
    let current = await getStatus({ reverifyGps: false });

    if (hasConfigChanged(current.config, config)) {
      current = clearVerificationFields(current, { preserveTab: true });
    }

    const { tabId, tabUrl } = await ensureDedicatedTab({ current, targetUrl });

    return applyOverrideAndVerifyGps({
      currentState: current,
      config,
      tabId,
      tabUrl,
    });
  }

  async function testLocation() {
    const current = await getStatus({ reverifyGps: false });
    if (!current.config) {
      return {
        ok: false,
        error: "Location is not configured yet. Enter coordinates and click Apply Location.",
        state: current,
      };
    }

    if (current.tabId === null || !current.debuggerAttached) {
      const detachedState = await saveLocationState(storageClient, {
        ...clearVerificationFields(current, { preserveTab: true }),
        debuggerAttached: false,
        browserGpsStatus: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        state: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        lastError: "Debugger is not attached to the dedicated tab. Click Apply Location first.",
      });
      return { ok: false, error: detachedState.lastError, state: detachedState };
    }

    try {
      await chromeApi.debugger.sendCommand({ tabId: current.tabId }, "Emulation.setGeolocationOverride", {
        latitude: current.config.latitude,
        longitude: current.config.longitude,
        accuracy: current.config.accuracy,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const detachedState = await saveLocationState(storageClient, {
        ...clearVerificationFields(current, { preserveTab: true }),
        debuggerAttached: false,
        browserGpsStatus: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        state: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        lastError: `Debugger connection lost: ${msg}`,
      });
      return { ok: false, error: detachedState.lastError, state: detachedState };
    }

    const verification = await verifyBrowserGeolocation({
      tabId: current.tabId,
      expectedLatitude: current.config.latitude,
      expectedLongitude: current.config.longitude,
      chromeApi,
    });

    const stillAttached = verification.state !== LOCATION_STATES.DEBUGGER_DISCONNECTED;
    const nextState = await saveLocationState(storageClient, {
      ...current,
      debuggerAttached: stillAttached,
      browserGpsStatus: verification.state,
      state: verification.state,
      permissionStatus: verification.permissionStatus,
      reportedCoords: verification.reportedCoords,
      latitudeDelta: verification.latitudeDelta,
      longitudeDelta: verification.longitudeDelta,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastError: verification.lastError,
    });

    return {
      ok: nextState.browserGpsStatus === LOCATION_STATES.GPS_VERIFIED,
      state: nextState,
      limitationNote: verification.limitationNote,
    };
  }

  async function openGoogleSearch(input = {}) {
    const hasFields = input && (input.latitude !== undefined || input.country || input.googleDomain);
    let current = await getStatus({ reverifyGps: false });
    let config = current.config;

    if (hasFields) {
      const validation = validateLocationInput(input);
      if (!validation.valid) {
        return { ok: false, errors: validation.errors, state: current };
      }
      config = validation.value;
      if (hasConfigChanged(current.config, config)) {
        current = clearVerificationFields(current, { preserveTab: true });
      }
    }

    const googleUrl =
      String(input?.googleSearchUrl || "").trim() ||
      buildGoogleLocationCheckUrl({
        googleDomain: config?.googleDomain,
        country: config?.country,
        language: config?.language,
      });

    const { tabId, tabUrl, reused } = await ensureDedicatedTab({
      current,
      targetUrl: googleUrl,
    });

    const nextState = await saveLocationState(storageClient, {
      ...current,
      config,
      tabId,
      tabUrl,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
      googleDetectedLocation: null,
      googleLocationSource: null,
      googleLocationSourceType: null,
      googleLastVerifiedAt: null,
      googleVerificationEvidence: null,
      state: current.browserGpsStatus === LOCATION_STATES.GPS_VERIFIED
        ? LOCATION_STATES.GPS_VERIFIED
        : config
          ? LOCATION_STATES.CONFIGURED
          : LOCATION_STATES.NOT_CONFIGURED,
      lastError: null,
    });

    return { ok: true, reused, state: nextState };
  }

  async function verifyGoogleLocation({ clickUpdateLocation = false } = {}) {
    const current = await getStatus({ reverifyGps: false });
    if (!current.config) {
      return {
        ok: false,
        error: "Location is not configured yet.",
        state: current,
      };
    }

    if (current.tabId === null || !current.debuggerAttached) {
      const disconnected = await saveLocationState(storageClient, {
        ...clearVerificationFields(current, { preserveTab: true }),
        debuggerAttached: false,
        browserGpsStatus: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        googleLocationStatus: GOOGLE_LOCATION_STATUSES.DEBUGGER_DISCONNECTED,
        state: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        lastError: "Debugger is not attached. Click Apply Google Location first.",
      });
      return { ok: false, error: disconnected.lastError, state: disconnected };
    }

    // Ensure browser GPS is actually verified right now (never present stale GPS as verified).
    const gpsCheck = await verifyBrowserGeolocation({
      tabId: current.tabId,
      expectedLatitude: current.config.latitude,
      expectedLongitude: current.config.longitude,
      chromeApi,
    });

    const gpsAttached = gpsCheck.state !== LOCATION_STATES.DEBUGGER_DISCONNECTED;
    if (!gpsAttached || gpsCheck.state === LOCATION_STATES.PERMISSION_DENIED || gpsCheck.state === LOCATION_STATES.VERIFICATION_FAILED) {
      const updated = await saveLocationState(storageClient, {
        ...current,
        debuggerAttached: gpsAttached,
        browserGpsStatus: gpsCheck.state,
        permissionStatus: gpsCheck.permissionStatus,
        reportedCoords: gpsCheck.reportedCoords,
        latitudeDelta: gpsCheck.latitudeDelta,
        longitudeDelta: gpsCheck.longitudeDelta,
        lastVerifiedAt: gpsCheck.lastVerifiedAt,
        googleLocationStatus: gpsAttached
          ? GOOGLE_LOCATION_STATUSES.UNVERIFIED
          : GOOGLE_LOCATION_STATUSES.DEBUGGER_DISCONNECTED,
        state: gpsCheck.state,
        lastError: gpsCheck.lastError,
      });
      return { ok: false, error: updated.lastError, state: updated };
    }

    const googleRes = await verifyGoogleSearchLocation({
      tabId: current.tabId,
      targetCity: current.config.targetCity || current.config.locationName,
      targetCountry: current.config.country,
      clickUpdateLocation,
      chromeApi,
    });

    const stillAttached = googleRes.status !== GOOGLE_LOCATION_STATUSES.DEBUGGER_DISCONNECTED;
    const nextState = await saveLocationState(storageClient, {
      ...current,
      debuggerAttached: stillAttached,
      browserGpsStatus: gpsCheck.state,
      permissionStatus: gpsCheck.permissionStatus,
      reportedCoords: gpsCheck.reportedCoords,
      latitudeDelta: gpsCheck.latitudeDelta,
      longitudeDelta: gpsCheck.longitudeDelta,
      lastVerifiedAt: gpsCheck.lastVerifiedAt,
      googleLocationStatus: googleRes.status,
      googleDetectedLocation: googleRes.detectedLocation,
      googleLocationSource: googleRes.locationSource,
      googleLocationSourceType: googleRes.locationSourceType,
      googleLastVerifiedAt: googleRes.checkedAt,
      googleVerificationEvidence: {
        pageUrl: googleRes.pageUrl,
        checkedAt: googleRes.checkedAt,
        matchedBy: googleRes.matchedBy,
        sourceType: googleRes.locationSourceType,
      },
      state: googleRes.status,
      lastError: googleRes.error,
      warningMessage: googleRes.warning,
    });

    return {
      ok: nextState.googleLocationStatus === GOOGLE_LOCATION_STATUSES.MATCHED,
      state: nextState,
      error: googleRes.error,
    };
  }

  async function applyGoogleLocation(input = {}) {
    const validation = validateLocationInput(input);
    if (!validation.valid) {
      return {
        ok: false,
        errors: validation.errors,
        state: await getStatus({ reverifyGps: false }),
      };
    }

    const config = validation.value;
    const googleUrl =
      String(input?.googleSearchUrl || "").trim() ||
      buildGoogleLocationCheckUrl({
        googleDomain: config.googleDomain,
        country: config.country,
        language: config.language,
      });

    let current = await getStatus({ reverifyGps: false });
    if (hasConfigChanged(current.config, config)) {
      current = clearVerificationFields(current, { preserveTab: true });
    }

    const { tabId, tabUrl } = await ensureDedicatedTab({ current, targetUrl: googleUrl });

    const gpsResult = await applyOverrideAndVerifyGps({
      currentState: current,
      config,
      tabId,
      tabUrl,
    });

    if (!gpsResult.ok) {
      return gpsResult;
    }

    return verifyGoogleLocation({
      clickUpdateLocation: Boolean(input.clickUpdateLocation),
    });
  }

  async function resetLocation() {
    const current = await loadLocationState(storageClient);
    await safeDetachDebugger({ tabId: current.tabId, chromeApi });

    const nextState = await saveLocationState(storageClient, {
      ...createDefaultLocationState(),
      config: current.config,
      browserGpsStatus: current.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
      state: current.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
    });

    return { ok: true, state: nextState };
  }

  async function handleDebuggerDetached({ tabId, reason }) {
    const current = await loadLocationState(storageClient);
    if (current.tabId !== null && current.tabId === tabId && current.debuggerAttached) {
      return saveLocationState(storageClient, {
        ...clearVerificationFields(current, { preserveTab: true }),
        debuggerAttached: false,
        browserGpsStatus: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        googleLocationStatus: GOOGLE_LOCATION_STATUSES.DEBUGGER_DISCONNECTED,
        state: LOCATION_STATES.DEBUGGER_DISCONNECTED,
        lastError: `Debugger disconnected (${reason || "unknown reason"}).`,
      });
    }
    return current;
  }

  async function handleTabRemoved({ tabId }) {
    const current = await loadLocationState(storageClient);
    if (current.tabId !== null && current.tabId === tabId) {
      const wasAttached = Boolean(current.debuggerAttached);
      return saveLocationState(storageClient, {
        ...clearVerificationFields(current, { preserveTab: false }),
        browserGpsStatus: wasAttached
          ? LOCATION_STATES.DEBUGGER_DISCONNECTED
          : current.config
            ? LOCATION_STATES.CONFIGURED
            : LOCATION_STATES.NOT_CONFIGURED,
        state: wasAttached
          ? LOCATION_STATES.DEBUGGER_DISCONNECTED
          : current.config
            ? LOCATION_STATES.CONFIGURED
            : LOCATION_STATES.NOT_CONFIGURED,
        lastError: wasAttached ? "Dedicated tab was closed." : current.lastError,
      });
    }
    return current;
  }

  async function handleTabUpdated({ tabId, changeInfo }) {
    if (!changeInfo?.url) {
      return null;
    }
    const current = await loadLocationState(storageClient);
    if (current.tabId !== null && current.tabId === tabId) {
      const evidenceUrl = current.googleVerificationEvidence?.pageUrl;
      if (
        evidenceUrl &&
        normalizeUrlForComparison(changeInfo.url) !== normalizeUrlForComparison(evidenceUrl)
      ) {
        return saveLocationState(storageClient, {
          ...current,
          tabUrl: changeInfo.url,
          googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
          googleDetectedLocation: null,
          googleLocationSource: null,
          googleLocationSourceType: null,
          googleLastVerifiedAt: null,
          googleVerificationEvidence: null,
          warningMessage: "Tab navigated to a new URL; previous Google location verification was cleared.",
        });
      }
      if (normalizeUrlForComparison(changeInfo.url) !== normalizeUrlForComparison(current.tabUrl)) {
        return saveLocationState(storageClient, {
          ...current,
          tabUrl: changeInfo.url,
        });
      }
    }
    return current;
  }

  return {
    getStatus,
    openTestTab,
    applyLocation,
    testLocation,
    openGoogleSearch,
    applyGoogleLocation,
    verifyGoogleLocation,
    resetLocation,
    handleDebuggerDetached,
    handleTabRemoved,
    handleTabUpdated,
  };
}
