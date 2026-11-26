/**
 * Geolocation controller managing the dedicated test tab, Chrome Debugger API,
 * Emulation.setGeolocationOverride, permission/GPS verification, and safe reset.
 */

import { DEFAULT_ACCURACY_METRES, validateLocationInput } from "./coordinate-validator.js";
import { verifyBrowserGeolocation } from "./geolocation-verifier.js";
import {
  createDefaultLocationState,
  GOOGLE_LOCATION_STATUSES,
  loadLocationState,
  LOCATION_STATES,
  revalidateLocationSession,
  saveLocationState,
} from "./location-state.js";

export const DEFAULT_TEST_PAGE_URL = "https://example.com/";
const DEBUGGER_PROTOCOL_VERSION = "1.3";

function isTabReady(tab) {
  return Boolean(tab && tab.status === "complete");
}

async function waitForTabLoad({ tabId, chromeApi, timeoutMs = 10000 }) {
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

  async function getStatus() {
    const stored = await loadLocationState(storageClient);
    const revalidated = await revalidateLocationSession({ state: stored, chromeApi });
    if (JSON.stringify(revalidated) !== JSON.stringify(stored)) {
      await saveLocationState(storageClient, revalidated);
    }
    return revalidated;
  }

  async function openTestTab({ testPageUrl } = {}) {
    const current = await getStatus();
    const targetUrl =
      String(testPageUrl || current.config?.testPageUrl || DEFAULT_TEST_PAGE_URL).trim() ||
      DEFAULT_TEST_PAGE_URL;

    if (current.tabId !== null) {
      try {
        const existing = await chromeApi.tabs.get(current.tabId);
        if (existing && existing.id === current.tabId) {
          await chromeApi.tabs.update(existing.id, { active: true });
          return { ok: true, reused: true, state: current };
        }
      } catch {
        // Tab no longer exists; fall through to create a new one.
      }
    }

    const tab = await chromeApi.tabs.create({ url: targetUrl, active: true });
    await waitForTabLoad({ tabId: tab.id, chromeApi });

    const nextState = await saveLocationState(storageClient, {
      ...current,
      tabId: tab.id,
      tabUrl: tab.url || targetUrl,
      debuggerAttached: false,
      state: current.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
      lastError: null,
    });

    return { ok: true, reused: false, state: nextState };
  }

  async function applyLocation({
    locationName = "",
    latitude,
    longitude,
    accuracy = DEFAULT_ACCURACY_METRES,
    country = "",
    language = "",
    testPageUrl = "",
  } = {}) {
    const validation = validateLocationInput({
      locationName,
      latitude,
      longitude,
      accuracy,
      country,
      language,
      testPageUrl,
    });

    if (!validation.valid) {
      return {
        ok: false,
        errors: validation.errors,
        state: await getStatus(),
      };
    }

    const config = validation.value;
    const targetUrl = config.testPageUrl || DEFAULT_TEST_PAGE_URL;
    let current = await getStatus();

    // Ensure dedicated test tab exists; reload if URL changed explicitly.
    let tabId = current.tabId;
    let tabUrl = current.tabUrl;
    let tabAvailable = false;

    if (tabId !== null) {
      try {
        const existing = await chromeApi.tabs.get(tabId);
        if (existing && existing.id === tabId) {
          tabAvailable = true;
          tabUrl = existing.url || targetUrl;
          await chromeApi.tabs.update(tabId, { active: true });
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

    // Save configured state before debugger attachment.
    current = await saveLocationState(storageClient, {
      ...current,
      state: LOCATION_STATES.CONFIGURED,
      config,
      tabId,
      tabUrl,
      lastError: null,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    });

    // Attach debugger if not already attached to this tab.
    if (!current.debuggerAttached) {
      try {
        await chromeApi.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const failedState = await saveLocationState(storageClient, {
          ...current,
          debuggerAttached: false,
          state: LOCATION_STATES.VERIFICATION_FAILED,
          lastError: `Debugger attach failed: ${msg}`,
        });
        return { ok: false, error: failedState.lastError, state: failedState };
      }
    }

    // Apply geolocation override via Chrome DevTools Protocol.
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
        ...current,
        debuggerAttached: false,
        state: detached ? LOCATION_STATES.DEBUGGER_DETACHED : LOCATION_STATES.VERIFICATION_FAILED,
        lastError: `Geolocation override failed: ${msg}`,
      });
      return { ok: false, error: failedState.lastError, state: failedState };
    }

    const appliedState = await saveLocationState(storageClient, {
      ...current,
      debuggerAttached: true,
      state: LOCATION_STATES.GPS_APPLIED,
      lastError: null,
    });

    // Verify browser GPS & permission inside the dedicated test tab.
    const verification = await verifyBrowserGeolocation({
      tabId,
      expectedLatitude: config.latitude,
      expectedLongitude: config.longitude,
      chromeApi,
    });

    const stillAttached = verification.state !== LOCATION_STATES.DEBUGGER_DETACHED;
    const finalState = await saveLocationState(storageClient, {
      ...appliedState,
      debuggerAttached: stillAttached,
      state: verification.state,
      permissionStatus: verification.permissionStatus,
      reportedCoords: verification.reportedCoords,
      latitudeDelta: verification.latitudeDelta,
      longitudeDelta: verification.longitudeDelta,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastError: verification.lastError,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    });

    return {
      ok: finalState.state === LOCATION_STATES.GPS_VERIFIED,
      state: finalState,
      limitationNote: verification.limitationNote,
    };
  }

  async function testLocation() {
    const current = await getStatus();
    if (!current.config) {
      return {
        ok: false,
        error: "Location is not configured yet. Enter coordinates and click Apply Location.",
        state: current,
      };
    }

    if (current.tabId === null || !current.debuggerAttached) {
      const detachedState = await saveLocationState(storageClient, {
        ...current,
        debuggerAttached: false,
        state: LOCATION_STATES.DEBUGGER_DETACHED,
        lastError: "Debugger is not attached to the test tab. Click Apply Location first.",
      });
      return { ok: false, error: detachedState.lastError, state: detachedState };
    }

    // Re-apply Emulation.setGeolocationOverride in case the test page was reloaded.
    try {
      await chromeApi.debugger.sendCommand({ tabId: current.tabId }, "Emulation.setGeolocationOverride", {
        latitude: current.config.latitude,
        longitude: current.config.longitude,
        accuracy: current.config.accuracy,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const detachedState = await saveLocationState(storageClient, {
        ...current,
        debuggerAttached: false,
        state: LOCATION_STATES.DEBUGGER_DETACHED,
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

    const stillAttached = verification.state !== LOCATION_STATES.DEBUGGER_DETACHED;
    const nextState = await saveLocationState(storageClient, {
      ...current,
      debuggerAttached: stillAttached,
      state: verification.state,
      permissionStatus: verification.permissionStatus,
      reportedCoords: verification.reportedCoords,
      latitudeDelta: verification.latitudeDelta,
      longitudeDelta: verification.longitudeDelta,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastError: verification.lastError,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    });

    return {
      ok: nextState.state === LOCATION_STATES.GPS_VERIFIED,
      state: nextState,
      limitationNote: verification.limitationNote,
    };
  }

  async function resetLocation() {
    const current = await loadLocationState(storageClient);
    await safeDetachDebugger({ tabId: current.tabId, chromeApi });

    const nextState = await saveLocationState(storageClient, {
      ...createDefaultLocationState(),
      config: current.config,
      state: current.config ? LOCATION_STATES.CONFIGURED : LOCATION_STATES.NOT_CONFIGURED,
    });

    return { ok: true, state: nextState };
  }

  async function handleDebuggerDetached({ tabId, reason }) {
    const current = await loadLocationState(storageClient);
    if (current.tabId !== null && current.tabId === tabId && current.debuggerAttached) {
      return saveLocationState(storageClient, {
        ...current,
        debuggerAttached: false,
        state: LOCATION_STATES.DEBUGGER_DETACHED,
        lastError: `Debugger detached (${reason || "unknown reason"}).`,
      });
    }
    return current;
  }

  async function handleTabRemoved({ tabId }) {
    const current = await loadLocationState(storageClient);
    if (current.tabId !== null && current.tabId === tabId) {
      const wasAttached = Boolean(current.debuggerAttached);
      return saveLocationState(storageClient, {
        ...current,
        tabId: null,
        tabUrl: null,
        debuggerAttached: false,
        state: wasAttached
          ? LOCATION_STATES.DEBUGGER_DETACHED
          : current.config
            ? LOCATION_STATES.CONFIGURED
            : LOCATION_STATES.NOT_CONFIGURED,
        lastError: wasAttached ? "Dedicated test tab was closed." : current.lastError,
      });
    }
    return current;
  }

  return {
    getStatus,
    openTestTab,
    applyLocation,
    testLocation,
    resetLocation,
    handleDebuggerDetached,
    handleTabRemoved,
  };
}

