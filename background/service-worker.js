import { exportClientConfiguration, importClientConfiguration } from "../modules/clients/client-import-export.js";
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createJobManager } from "../modules/jobs/job-manager.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { createHistoryStorage } from "../modules/history/history-storage.js";
import { buildCurrentAndPreviousSnapshots, buildKeywordTrendSeries, compareTwoReportingDates } from "../modules/history/ranking-history.js";
import { computeAgencyOverviewMetrics, computeClientDashboardMetrics } from "../modules/history/ranking-metrics.js";
import { createActivityLogger, LOG_CATEGORIES } from "../modules/logging/activity-logger.js";
import { generateAgencyCsvReport } from "../modules/reports/report-generator.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createGoogleAuthClient } from "../modules/sheets/google-auth.js";
import { createSheetBackupManager } from "../modules/sheets/sheet-backup-manager.js";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { applyConfirmedSheetSync } from "../modules/sheets/sheet-sync.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { createSheetsWriteClient } from "../modules/sheets/sheets-write-client.js";
import { createUpdateJournal } from "../modules/sheets/update-journal.js";
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

  const googleAuthClient = createGoogleAuthClient({
    identityApi: chromeApi?.identity,
    runtimeApi: chromeApi?.runtime,
    storageClient: storage,
  });
  const sheetsApiClient = createSheetsApiClient({ authClient: googleAuthClient });
  const sheetsWriteClient = createSheetsWriteClient({ authClient: googleAuthClient });
  const sheetReader = createSheetReader({ sheetsApiClient, clientStorage });
  const sheetBackupManager = createSheetBackupManager({ sheetsApiClient, storageClient: storage });
  const updateJournal = createUpdateJournal({ clientStorage });
  const sheetUpdater = createSheetUpdater({
    authClient: googleAuthClient,
    sheetReader,
    sheetsApiClient,
    sheetsWriteClient,
    backupManager: sheetBackupManager,
    updateJournal,
    clientStorage,
    locationManager,
  });
  const historyStorage = createHistoryStorage({ storageClient: storage });
  const activityLogger = createActivityLogger({ storageClient: storage });

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
    googleAuthClient,
    sheetsApiClient,
    sheetsWriteClient,
    sheetReader,
    sheetBackupManager,
    updateJournal,
    sheetUpdater,
    historyStorage,
    activityLogger,
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
    googleAuthClient,
    sheetsWriteClient,
    sheetReader,
    sheetBackupManager,
    sheetUpdater,
    historyStorage,
    activityLogger,
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

    case MESSAGE_TYPES.LOCATION_APPLY: {
      const res = await locationController.applyLocation(message.payload || {});
      await activityLogger.logEvent({
        category: LOG_CATEGORIES.LOCATION_VERIFICATION,
        level: res.ok ? "info" : "warning",
        message: res.ok
          ? `Applied browser GPS location (${message.payload?.locationName || "custom"})`
          : `Location apply warning: ${res.errors?.join(" ") || res.error || "Mismatch"}`,
      });
      return res;
    }

    case MESSAGE_TYPES.LOCATION_TEST:
      return locationController.testLocation();

    case MESSAGE_TYPES.LOCATION_RESET:
      return locationController.resetLocation();

    case MESSAGE_TYPES.GOOGLE_LOCATION_APPLY:
      return locationController.applyGoogleLocation(message.payload || {});

    case MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY: {
      const res = await locationController.verifyGoogleLocation(message.payload || {});
      await activityLogger.logEvent({
        category: LOG_CATEGORIES.LOCATION_VERIFICATION,
        level: res.ok ? "info" : "warning",
        message: res.ok
          ? `Google Search location verified (${res.state?.googleDetectedLocation || "matched"})`
          : `Google Search location check status: ${res.state?.googleLocationStatus || res.error || "unverified"}`,
      });
      return res;
    }

    case MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH:
      return locationController.openGoogleSearch(message.payload || {});

    case MESSAGE_TYPES.RANKING_CHECK: {
      const res = await rankingChecker.checkRanking(message.payload || {});
      if (res?.result) {
        const active = await clientStorage.getActiveSelection();
        await historyStorage.saveRankingHistoryBatch([
          {
            ...res.result,
            clientId: message.payload?.clientId || active?.clientId || "unassigned",
            locationId: message.payload?.locationId || active?.locationId || null,
            sourceMode: res.result.useManualHtml ? "manual_html" : "live_single",
          },
        ]);
        if (String(res.result.status).toLowerCase().includes("captcha") || res.result.status === "Search blocked") {
          await activityLogger.logEvent({
            category: LOG_CATEGORIES.CAPTCHA_DETECTED,
            level: "error",
            clientId: active?.clientId || null,
            message: `Search blocked / CAPTCHA during single check for '${res.result.keyword}'.`,
          });
        }
      }
      return res;
    }

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
      if (res?.tasks?.length) {
        await historyStorage.saveRankingHistoryBatch(
          res.tasks.map((t) => ({
            ...t,
            clientId: res.job?.clientId || "unassigned",
            locationId: res.job?.locationId || null,
            locationName: res.job?.locationConfig?.locationName || "",
            deviceType: res.job?.deviceType || "Desktop",
            sourceMode: "live_bulk",
          }))
        );
      }
      if (res?.job) {
        const hasCaptcha = (res.tasks || []).some((t) => t.status === "Search blocked");
        await activityLogger.logEvent({
          category: hasCaptcha
            ? LOG_CATEGORIES.CAPTCHA_DETECTED
            : res.job.state === "Completed"
              ? LOG_CATEGORIES.JOB_COMPLETED
              : LOG_CATEGORIES.JOB_INTERRUPTED,
          level: res.ok ? "info" : "warning",
          clientId: res.job.clientId || null,
          message: `Bulk job ${res.job.jobId} finished with state '${res.job.state}' (${res.job.totalKeywords} keywords).`,
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
      if (res?.tasks?.length) {
        await historyStorage.saveRankingHistoryBatch(
          res.tasks.map((t) => ({
            ...t,
            clientId: res.job?.clientId || "unassigned",
            locationId: res.job?.locationId || null,
            sourceMode: "live_bulk",
          }))
        );
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
      if (res?.tasks?.length) {
        await historyStorage.saveRankingHistoryBatch(
          res.tasks.map((t) => ({
            ...t,
            clientId: res.job?.clientId || "unassigned",
            locationId: res.job?.locationId || null,
            sourceMode: "live_bulk",
          }))
        );
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

    case MESSAGE_TYPES.CLIENT_CREATE: {
      const res = await clientManager.createClient(message.payload || {});
      if (res?.ok) {
        await activityLogger.logEvent({
          category: LOG_CATEGORIES.CLIENT_CONFIG,
          clientId: res.client.clientId,
          message: `Created client '${res.client.clientName}' (${res.client.websiteDomain}).`,
        });
      }
      return res;
    }

    case MESSAGE_TYPES.CLIENT_UPDATE: {
      const res = await clientManager.updateClient(message.payload?.clientId, message.payload?.updates || {});
      if (res?.ok) {
        await activityLogger.logEvent({
          category: LOG_CATEGORIES.CLIENT_CONFIG,
          clientId: res.client.clientId,
          message: `Updated configuration for client '${res.client.clientName}'.`,
        });
      }
      return res;
    }

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

    // Phase 8 Read-Only Google Sheets routes
    case MESSAGE_TYPES.SHEETS_GET_AUTH_STATUS:
      return googleAuthClient.getStatus();

    case MESSAGE_TYPES.SHEETS_CONNECT:
      return googleAuthClient.connect();

    case MESSAGE_TYPES.SHEETS_DISCONNECT:
      return googleAuthClient.disconnect();

    case MESSAGE_TYPES.SHEETS_TEST_CONNECTION:
      return googleAuthClient.testConnection({
        spreadsheetId: message.payload?.spreadsheetId || "",
      });

    case MESSAGE_TYPES.SHEETS_LIST_WORKSHEETS:
      return sheetReader.listWorksheets({
        sheetUrlOrId: message.payload?.sheetUrlOrId || "",
      });

    case MESSAGE_TYPES.SHEETS_PREVIEW_AND_READ: {
      const p = message.payload || {};
      const client = p.clientId ? await clientStorage.getClient(p.clientId) : null;
      return sheetReader.readAndAnalyzeSheet({
        clientId: p.clientId,
        locationId: p.locationId || null,
        sheetUrlOrId: p.sheetUrlOrId || client?.sheetConfig?.sheetUrl || client?.sheetConfig?.spreadsheetId || "",
        worksheetId: p.worksheetId ?? client?.sheetConfig?.worksheetId ?? "",
        worksheetName: p.worksheetName ?? client?.sheetConfig?.worksheetName ?? "",
        columnConfig: p.columnConfig || client?.sheetConfig || {},
        excludedRowNumbers: p.excludedRowNumbers || [],
      });
    }

    case MESSAGE_TYPES.SHEETS_APPLY_CONFIRMED_SYNC:
      return applyConfirmedSheetSync({
        clientStorage,
        clientId: message.payload?.clientId,
        incomingKeywords: message.payload?.incomingKeywords || [],
        snapshot: message.payload?.snapshot,
        confirmed: Boolean(message.payload?.confirmed),
      });

    // Phase 9 Format-Preserving Google Sheets Updates routes
    case MESSAGE_TYPES.SHEETS_ENABLE_WRITE:
      return googleAuthClient.enableWriteAccess({
        userConfirmed: Boolean(message.payload?.userConfirmed),
      });

    case MESSAGE_TYPES.SHEETS_DISABLE_WRITE:
      return googleAuthClient.disableWriteAccess();

    case MESSAGE_TYPES.SHEETS_BACKUP_CREATE: {
      const p = message.payload || {};
      return sheetBackupManager.createAndVerifyBackup({
        clientId: p.clientId,
        spreadsheetId: p.spreadsheetId,
        worksheetId: p.worksheetId,
        worksheetName: p.worksheetName,
        jobId: p.jobId || null,
      });
    }

    case MESSAGE_TYPES.SHEETS_BACKUP_LIST:
      return {
        ok: true,
        backups: await sheetBackupManager.listBackupsForClient(message.payload?.clientId),
      };

    case MESSAGE_TYPES.SHEETS_UPDATE_PREVIEW: {
      const p = message.payload || {};
      const clientJobs = p.clientId ? await clientStorage.listJobsByClient(p.clientId) : [];
      const job = p.job || clientJobs.find((j) => j.jobId === p.jobId) || clientJobs[0];
      const allClientResults = p.clientId ? await clientStorage.listResultsByClient(p.clientId) : [];
      const tasks = p.tasks || (job ? allClientResults.filter((r) => r.jobId === job.jobId) : []);
      return sheetUpdater.generatePreview({
        clientId: p.clientId,
        locationId: p.locationId || null,
        job,
        tasks,
        reportingDate: p.reportingDate || new Date().toISOString().slice(0, 10),
        explicitHeaderLabel: p.explicitHeaderLabel || "",
        backupId: p.backupId || null,
      });
    }

    case MESSAGE_TYPES.SHEETS_UPDATE_EXECUTE: {
      const p = message.payload || {};
      const clientJobs = p.clientId ? await clientStorage.listJobsByClient(p.clientId) : [];
      const job = p.job || clientJobs.find((j) => j.jobId === p.jobId) || clientJobs[0];
      const allClientResults = p.clientId ? await clientStorage.listResultsByClient(p.clientId) : [];
      const tasks = p.tasks || (job ? allClientResults.filter((r) => r.jobId === job.jobId) : []);
      return sheetUpdater.executeApprovedUpdate({
        clientId: p.clientId,
        locationId: p.locationId || null,
        job,
        tasks,
        approvedPreview: p.approvedPreview,
        approvalConfirmation: Boolean(p.approvalConfirmation),
        backupId: p.backupId,
        reportingDate: p.reportingDate || new Date().toISOString().slice(0, 10),
        explicitHeaderLabel: p.explicitHeaderLabel || "",
        mode: p.mode || "dry-run",
        dryRun: p.dryRun !== false,
      });
    }

    case MESSAGE_TYPES.SHEETS_UPDATE_JOURNAL_LIST:
      return {
        ok: true,
        journal: await clientStorage.listUpdateJournalByClient(message.payload?.clientId),
      };

    case MESSAGE_TYPES.SHEETS_BACKUP_RESTORE: {
      const p = message.payload || {};
      const bkp = await sheetBackupManager.getBackup(p.backupId);
      const res = await sheetBackupManager.restoreFromBackup({
        backupRecord: bkp,
        writeClient: sheetsWriteClient,
        mode: p.mode || "dry-run",
        dryRun: p.dryRun !== false,
        confirmedByUser: Boolean(p.confirmedByUser),
      });
      await activityLogger.logEvent({
        category: LOG_CATEGORIES.RECOVERY,
        level: res.ok ? "info" : "error",
        clientId: bkp?.clientId || null,
        message: res.ok
          ? `Backup restore executed (${res.dryRun ? "dry-run" : "live"}) using '${p.backupId}'.`
          : `Backup restore blocked/failed: ${res.error}`,
      });
      return res;
    }

    // Phase 10 Agency Dashboard, History, Reports, Logs, and Settings routes
    case MESSAGE_TYPES.DASHBOARD_AGENCY_OVERVIEW: {
      const clients = await clientStorage.listClients();
      await historyStorage.migrateLegacyResultsToHistory({ clients, clientStorage });
      const allLocations = [];
      const allKeywords = [];
      const allJobs = [];
      const allJournal = [];
      for (const c of clients) {
        allLocations.push(...(await locationManager.listLocations(c.clientId)));
        allKeywords.push(...(await keywordManager.listKeywords(c.clientId)));
        allJobs.push(...(await clientStorage.listJobsByClient(c.clientId)));
        allJournal.push(...(await clientStorage.listUpdateJournalByClient(c.clientId)));
      }
      const historyRecords = await historyStorage.queryRankingHistory({ limit: 5000 });
      const metrics = computeAgencyOverviewMetrics({
        clients,
        locations: allLocations,
        keywords: allKeywords,
        historyRecords,
        jobs: allJobs,
        journalEntries: allJournal,
      });
      return {
        ok: true,
        metrics,
        snapshots: buildCurrentAndPreviousSnapshots(historyRecords),
      };
    }

    case MESSAGE_TYPES.CLIENT_DASHBOARD_METRICS: {
      const cid = message.payload?.clientId;
      const client = await clientStorage.getClient(cid);
      if (!client) return { ok: false, error: "Client not found." };
      await historyStorage.migrateLegacyResultsToHistory({ clients: [client], clientStorage });
      const locations = await locationManager.listLocations(cid);
      const keywords = await keywordManager.listKeywords(cid);
      const jobs = await clientStorage.listJobsByClient(cid);
      const journalEntries = await clientStorage.listUpdateJournalByClient(cid);
      const historyRecords = await historyStorage.queryRankingHistory({ clientId: cid, limit: 2000 });
      const metrics = computeClientDashboardMetrics({
        client,
        locations,
        keywords,
        historyRecords,
        jobs,
        journalEntries,
      });
      return { ok: true, metrics };
    }

    case MESSAGE_TYPES.HISTORY_QUERY: {
      const p = message.payload || {};
      const clients = await clientStorage.listClients();
      await historyStorage.migrateLegacyResultsToHistory({ clients, clientStorage });
      const records = await historyStorage.queryRankingHistory(p);
      return {
        ok: true,
        records,
        snapshots: buildCurrentAndPreviousSnapshots(records),
      };
    }

    case MESSAGE_TYPES.HISTORY_COMPARE_DATES: {
      const p = message.payload || {};
      const records = await historyStorage.queryRankingHistory({
        clientId: p.clientId || null,
        locationId: p.locationId || null,
        limit: 5000,
      });
      return {
        ok: true,
        comparisons: compareTwoReportingDates({
          historyRecords: records,
          dateA: p.dateA,
          dateB: p.dateB,
          clientId: p.clientId || null,
          locationId: p.locationId || null,
        }),
      };
    }

    case MESSAGE_TYPES.HISTORY_TREND: {
      const p = message.payload || {};
      const records = await historyStorage.queryRankingHistory({
        clientId: p.clientId || null,
        locationId: p.locationId || null,
        keywordId: p.keywordId || null,
        limit: 1000,
      });
      return {
        ok: true,
        series: buildKeywordTrendSeries({
          historyRecords: records,
          clientId: p.clientId,
          locationId: p.locationId || null,
          keywordId: p.keywordId || null,
          keywordText: p.keywordText || "",
        }),
      };
    }

    case MESSAGE_TYPES.JOBS_LIST_ALL: {
      const clients = await clientStorage.listClients();
      const jobs = [];
      for (const c of clients) {
        const cJobs = await clientStorage.listJobsByClient(c.clientId);
        for (const j of cJobs) {
          jobs.push({ ...j, clientName: c.clientName });
        }
      }
      jobs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return { ok: true, jobs };
    }

    case MESSAGE_TYPES.REPORTS_GENERATE: {
      const p = message.payload || {};
      const clients = await clientStorage.listClients();
      await historyStorage.migrateLegacyResultsToHistory({ clients, clientStorage });
      const locationsByClient = {};
      const keywordsByClient = {};
      const allJobs = [];
      const allJournal = [];
      for (const c of clients) {
        locationsByClient[c.clientId] = await locationManager.listLocations(c.clientId);
        keywordsByClient[c.clientId] = await keywordManager.listKeywords(c.clientId);
        allJobs.push(...(await clientStorage.listJobsByClient(c.clientId)));
        allJournal.push(...(await clientStorage.listUpdateJournalByClient(c.clientId)));
      }
      const historyRecords = await historyStorage.queryRankingHistory({
        clientId: p.clientId || null,
        limit: 5000,
      });
      const out = generateAgencyCsvReport({
        reportType: p.reportType,
        clients: p.clientId ? clients.filter((c) => c.clientId === p.clientId) : clients,
        locationsByClient,
        keywordsByClient,
        historyRecords,
        jobs: allJobs,
        journalEntries: allJournal,
        accuracyComparisons: p.accuracyComparisons || [],
      });
      return { ok: true, ...out };
    }

    case MESSAGE_TYPES.ACTIVITY_LIST:
      return {
        ok: true,
        logs: await activityLogger.queryLogs(message.payload || {}),
      };

    case MESSAGE_TYPES.ACTIVITY_EXPORT_CSV: {
      const logs = await activityLogger.queryLogs(message.payload || {});
      return {
        ok: true,
        filename: "agency-activity-logs.csv",
        csv: activityLogger.exportLogsAsCsv(logs),
      };
    }

    case MESSAGE_TYPES.SETTINGS_GET:
      return {
        ok: true,
        settings: await historyStorage.loadSettings(),
      };

    case MESSAGE_TYPES.SETTINGS_SAVE:
      return historyStorage.saveSettings(message.payload || {});

    case MESSAGE_TYPES.DIAGNOSTICS_INFO: {
      const schemaInfo = await historyStorage.getSchemaInfo();
      const ping = await storage.pingStorage();
      return {
        ok: true,
        version,
        storageOk: ping.ok,
        databaseBackend: schemaInfo.backend,
        schemaVersion: schemaInfo.version,
        stores: schemaInfo.stores,
      };
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
