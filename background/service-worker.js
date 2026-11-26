import { exportClientConfiguration, importClientConfiguration } from "../modules/clients/client-import-export.js";
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createJobManager } from "../modules/jobs/job-manager.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createStorageClient, STORAGE_KEYS } from "../modules/storage/storage.js";
import { buildHealthReport } from "../utils/health.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

// Keep per-storage-instance services & shared search lock so Pause/Stop and lock enforcement work.
const serviceCache = new WeakMap();

function getOrCreateServices(chromeApi) {
  const storageArea = chromeApi?.storage?.local;
  const cached = storageArea ? serviceCache.get(storageArea) : null;
  if (cached) {
    return cached;
  }

  const storage = createStorageClient(storageArea);
  const searchLock = { owner: null };
  const locationController = createGeolocationController({
    chromeApi,
    storageClient: storage,
  });
  const rankingChecker = createSingleKeywordChecker({
    chromeApi,
    storageClient: storage,
    locationController,
    searchLock,
  });

  const jobStorage = createJobStorage({ storageClient: storage });
  const jobManager = createJobManager({
    jobStorage,
    locationController,
    singleKeywordChecker: rankingChecker,
    searchLock,
  });

  const clientStorage = createClientStorage({ storageClient: storage });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });
  const clientManager = createClientManager({
    clientStorage,
    locationManager,
    keywordManager,
    locationController,
    jobManager,
  });

  const bundle = {
    storage,
    searchLock,
    locationController,
    rankingChecker,
    jobStorage,
    jobManager,
    clientStorage,
    locationManager,
    keywordManager,
    clientManager,
  };

  if (storageArea) {
    serviceCache.set(storageArea, bundle);
  }
  return bundle;
}

/**
 * Handle runtime messages from popup and dashboard pages.
 * Accepts an injectable chromeApi object so tests can run in Node.js without Chrome.
 */
export async function handleRuntimeMessage(message, _sender, chromeApi = globalThis.chrome) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message payload." };
  }

  const version = chromeApi?.runtime?.getManifest?.().version || "0.1.0";
  const {
    storage,
    locationController,
    rankingChecker,
    jobManager,
    clientStorage,
    locationManager,
    keywordManager,
    clientManager,
  } = getOrCreateServices(chromeApi);

  switch (message.type) {
    case MESSAGE_TYPES.HEALTH_CHECK: {
      const ping = await storage.pingStorage();
      return buildHealthReport({
        version,
        storageOk: ping.ok,
        checkedAt: ping.checkedAt,
        notes: ["Phase 7 core ready (multi-client management, location, ranking, and bulk queue)."],
      });
    }

    case MESSAGE_TYPES.STORAGE_SELF_TEST: {
      const ping = await storage.pingStorage();
      return { ok: ping.ok, checkedAt: ping.checkedAt };
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

    case MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB:
      return locationController.openTestTab({ testPageUrl: message.payload?.testPageUrl });

    case MESSAGE_TYPES.LOCATION_APPLY:
      return locationController.applyLocation(message.payload || {});

    case MESSAGE_TYPES.LOCATION_TEST:
      return locationController.testLocation();

    case MESSAGE_TYPES.LOCATION_RESET:
      return locationController.resetLocation();

    case MESSAGE_TYPES.GOOGLE_LOCATION_APPLY:
      return locationController.applyGoogleLocation(message.payload || {});

    case MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY:
      return locationController.verifyGoogleLocation(message.payload || {});

    case MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH:
      return locationController.openGoogleSearch(message.payload || {});

    case MESSAGE_TYPES.RANKING_CHECK:
      return rankingChecker.checkRanking(message.payload || {});

    case MESSAGE_TYPES.RANKING_STOP:
      return rankingChecker.stopCheck();

    case MESSAGE_TYPES.RANKING_CLEAR:
      return rankingChecker.clearResults();

    case MESSAGE_TYPES.RANKING_GET_STATE: {
      const state = await rankingChecker.getState();
      return { ok: true, state };
    }

    case MESSAGE_TYPES.BULK_GET_STATUS:
      return jobManager.getStatus();

    case MESSAGE_TYPES.BULK_START: {
      const res = await jobManager.startJob(message.payload || {});
      if (res?.job?.clientId) {
        await clientManager.recordClientJobOutcome({
          clientId: res.job.clientId,
          job: res.job,
          tasks: res.tasks || [],
        });
      }
      return res;
    }

    case MESSAGE_TYPES.BULK_PAUSE:
      return jobManager.pauseJob();

    case MESSAGE_TYPES.BULK_RESUME: {
      const res = await jobManager.resumeJob(message.payload || {});
      if (res?.job?.clientId) {
        await clientManager.recordClientJobOutcome({
          clientId: res.job.clientId,
          job: res.job,
          tasks: res.tasks || [],
        });
      }
      return res;
    }

    case MESSAGE_TYPES.BULK_STOP:
      return jobManager.stopJob();

    case MESSAGE_TYPES.BULK_RETRY_FAILED: {
      const res = await jobManager.retryFailedKeywords(message.payload || {});
      if (res?.job?.clientId) {
        await clientManager.recordClientJobOutcome({
          clientId: res.job.clientId,
          job: res.job,
          tasks: res.tasks || [],
        });
      }
      return res;
    }

    case MESSAGE_TYPES.BULK_CLEAR:
      return jobManager.clearResults(message.payload || {});

    // Phase 7 Client Management routes
    case MESSAGE_TYPES.CLIENT_LIST_OVERVIEWS: {
      const overviews = await clientManager.listClientOverviews(message.payload || {});
      const active = await clientStorage.getActiveSelection();
      return { ok: true, overviews, active };
    }

    case MESSAGE_TYPES.CLIENT_GET_WORKSPACE:
      return clientManager.getClientWorkspace(message.payload?.clientId, {
        locationId: message.payload?.locationId,
      });

    case MESSAGE_TYPES.CLIENT_CREATE:
      return clientManager.createClient(message.payload || {});

    case MESSAGE_TYPES.CLIENT_UPDATE:
      return clientManager.updateClient(message.payload?.clientId, message.payload?.updates || {});

    case MESSAGE_TYPES.CLIENT_ARCHIVE:
      return clientManager.archiveClient(message.payload?.clientId);

    case MESSAGE_TYPES.CLIENT_DUPLICATE:
      return clientManager.duplicateClient(message.payload?.clientId);

    case MESSAGE_TYPES.CLIENT_DELETE:
      return clientManager.deleteClient(message.payload?.clientId, {
        confirmed: Boolean(message.payload?.confirmed),
      });

    case MESSAGE_TYPES.CLIENT_SELECT:
      return clientManager.selectClient(message.payload || {});

    case MESSAGE_TYPES.CLIENT_ADD_LOCATION:
      return locationManager.addLocation(message.payload || {});

    case MESSAGE_TYPES.CLIENT_UPDATE_LOCATION:
      return locationManager.updateLocation(message.payload?.locationId, message.payload || {});

    case MESSAGE_TYPES.CLIENT_DELETE_LOCATION:
      return locationManager.deleteLocation(message.payload?.locationId);

    case MESSAGE_TYPES.CLIENT_ADD_KEYWORDS:
      return keywordManager.addKeywords(message.payload || {});

    case MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_TEXT:
      return keywordManager.importFromText(message.payload || {});

    case MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_CSV:
      return keywordManager.importFromCsv(message.payload || {});

    case MESSAGE_TYPES.CLIENT_UPDATE_KEYWORD:
      return keywordManager.updateKeyword(
        message.payload?.clientId,
        message.payload?.keywordId,
        message.payload?.updates || {}
      );

    case MESSAGE_TYPES.CLIENT_DELETE_KEYWORD:
      return keywordManager.deleteKeyword(message.payload?.keywordId);

    case MESSAGE_TYPES.CLIENT_EXPORT_CONFIG: {
      const ws = await clientManager.getClientWorkspace(message.payload?.clientId);
      if (!ws.ok) return ws;
      return {
        ok: true,
        json: exportClientConfiguration({
          client: ws.client,
          locations: ws.locations,
          keywords: ws.keywords,
        }),
      };
    }

    case MESSAGE_TYPES.CLIENT_IMPORT_CONFIG:
      return importClientConfiguration(message.payload?.json, {
        clientManager,
        locationManager,
        keywordManager,
      });

    case MESSAGE_TYPES.CLIENT_BACKUP_CREATE:
      return clientStorage.createClientBackup(message.payload?.clientId);

    case MESSAGE_TYPES.CLIENT_BACKUP_RESTORE:
      return clientStorage.restoreClientBackup(message.payload?.backup);

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
