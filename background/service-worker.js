import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createStorageClient, STORAGE_KEYS } from "../modules/storage/storage.js";
import { buildHealthReport } from "../utils/health.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

/**
 * Handle runtime messages from popup and dashboard pages.
 * Accepts an injectable chromeApi object so tests can run in Node.js without Chrome.
 */
export async function handleRuntimeMessage(message, _sender, chromeApi = globalThis.chrome) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message payload." };
  }

  const version = chromeApi?.runtime?.getManifest?.().version || "0.1.0";
  const storage = createStorageClient(chromeApi?.storage?.local);
  const locationController = createGeolocationController({
    chromeApi,
    storageClient: storage,
  });
  const rankingChecker = createSingleKeywordChecker({
    chromeApi,
    storageClient: storage,
    locationController,
  });

  switch (message.type) {
    case MESSAGE_TYPES.HEALTH_CHECK: {
      const ping = await storage.pingStorage();
      return buildHealthReport({
        version,
        storageOk: ping.ok,
        checkedAt: ping.checkedAt,
        notes: ["Phase 4 core ready (location verification + single keyword organic ranking)."],
      });
    }

    case MESSAGE_TYPES.STORAGE_SELF_TEST: {
      const ping = await storage.pingStorage();
      return {
        ok: ping.ok,
        checkedAt: ping.checkedAt,
      };
    }

    case MESSAGE_TYPES.OPEN_DASHBOARD: {
      const dashboardUrl = chromeApi.runtime.getURL("dashboard/dashboard.html");
      const existingTabs = await chromeApi.tabs.query({ url: dashboardUrl });
      if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
        await chromeApi.tabs.update(existingTabs[0].id, { active: true });
        return { ok: true, reused: true, tabId: existingTabs[0].id };
      }
      const created = await chromeApi.tabs.create({ url: dashboardUrl });
      return { ok: true, reused: false, tabId: created?.id ?? null };
    }

    case MESSAGE_TYPES.LOCATION_GET_STATUS: {
      const state = await locationController.getStatus({
        reverifyGps: message.payload?.reverifyGps !== false,
      });
      return { ok: true, state };
    }

    case MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB: {
      return locationController.openTestTab({
        testPageUrl: message.payload?.testPageUrl,
      });
    }

    case MESSAGE_TYPES.LOCATION_APPLY: {
      return locationController.applyLocation(message.payload || {});
    }

    case MESSAGE_TYPES.LOCATION_TEST: {
      return locationController.testLocation();
    }

    case MESSAGE_TYPES.LOCATION_RESET: {
      return locationController.resetLocation();
    }

    case MESSAGE_TYPES.GOOGLE_LOCATION_APPLY: {
      return locationController.applyGoogleLocation(message.payload || {});
    }

    case MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY: {
      return locationController.verifyGoogleLocation(message.payload || {});
    }

    case MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH: {
      return locationController.openGoogleSearch(message.payload || {});
    }

    case MESSAGE_TYPES.RANKING_CHECK: {
      return rankingChecker.checkRanking(message.payload || {});
    }

    case MESSAGE_TYPES.RANKING_STOP: {
      return rankingChecker.stopCheck();
    }

    case MESSAGE_TYPES.RANKING_CLEAR: {
      return rankingChecker.clearResults();
    }

    case MESSAGE_TYPES.RANKING_GET_STATE: {
      const state = await rankingChecker.getState();
      return { ok: true, state };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    try {
      const storage = createStorageClient(chrome.storage.local);
      await storage.set({
        [STORAGE_KEYS.EXTENSION_META]: {
          installedAt: new Date().toISOString(),
          reason: details.reason,
          version: chrome.runtime.getManifest().version,
        },
      });
    } catch (error) {
      console.error("Failed to initialize extension metadata:", error);
    }
  });

  if (chrome.debugger?.onDetach) {
    chrome.debugger.onDetach.addListener(async (source, reason) => {
      try {
        const storage = createStorageClient(chrome.storage.local);
        const controller = createGeolocationController({ chromeApi: chrome, storageClient: storage });
        await controller.handleDebuggerDetached({ tabId: source.tabId, reason });
      } catch (error) {
        console.error("Failed handling debugger detach:", error);
      }
    });
  }

  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
      try {
        const storage = createStorageClient(chrome.storage.local);
        const controller = createGeolocationController({ chromeApi: chrome, storageClient: storage });
        await controller.handleTabRemoved({ tabId });
      } catch (error) {
        console.error("Failed handling tab removal:", error);
      }
    });
  }

  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (!changeInfo?.url) return;
      try {
        const storage = createStorageClient(chrome.storage.local);
        const controller = createGeolocationController({ chromeApi: chrome, storageClient: storage });
        await controller.handleTabUpdated({ tabId, changeInfo });
      } catch (error) {
        console.error("Failed handling tab update:", error);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleRuntimeMessage(message, sender, chrome)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });
}
