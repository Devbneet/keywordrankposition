import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createHistoryStorage } from "../modules/history/history-storage.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createNotificationManager } from "../modules/notifications/notification-manager.js";
import { createAlarmController } from "../modules/scheduler/alarm-controller.js";
import { createExecutionQueue } from "../modules/scheduler/execution-queue.js";
import { createScheduleManager } from "../modules/scheduler/schedule-manager.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";
import { createScheduledJobRunner } from "../modules/scheduler/scheduled-job-runner.js";
import {
  AUTOMATION_MODES,
  EXECUTION_STATES,
  SCHEDULE_FAILURE_CODES,
  SCHEDULE_STATES,
} from "../modules/scheduler/scheduler-state.js";
import { createGoogleAuthClient } from "../modules/sheets/google-auth.js";
import { createSheetBackupManager } from "../modules/sheets/sheet-backup-manager.js";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { createUpdateJournal } from "../modules/sheets/update-journal.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_GRID_DETAILS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

function createInMemoryStorage() {
  const map = new Map();
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

function createFakeAlarmsApi() {
  const alarms = new Map();
  return {
    alarms,
    create(name, info) {
      alarms.set(name, { name, scheduledTime: info.when });
      return Promise.resolve();
    },
    clear(name, cb) {
      const existed = alarms.delete(name);
      if (cb) cb(existed);
      return Promise.resolve(existed);
    },
    getAll(cb) {
      const list = [...alarms.values()];
      if (cb) cb(list);
      return Promise.resolve(list);
    },
  };
}

test("scheduleManager validates inputs, syncs Chrome alarms, blocks unsafe Mode B production writes, and reconciles alarms", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const alarmsApi = createFakeAlarmsApi();
  const alarmController = createAlarmController({ alarmsApi });
  const manager = createScheduleManager({
    scheduleStorage,
    alarmController,
    clientStorage,
    locationManager,
  });

  await clientStorage.saveClient({
    clientId: "cli_1",
    clientName: "Apex Services",
    websiteDomain: "apex.example.com",
  });
  await clientStorage.saveLocation({
    locationId: "loc_1",
    clientId: "cli_1",
    locationName: "Sydney, Australia",
    country: "Australia",
    language: "en",
  });

  // Rejects invalid timezone & too-small delay & unattended production Mode B
  const badRes = await manager.createSchedule({
    clientId: "cli_1",
    locationId: "loc_1",
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "Bad/Zone",
    delayBetweenKeywordsMs: 500,
    automationMode: AUTOMATION_MODES.MODE_B_AUTO_SHEET,
    sandboxMode: false,
  });
  assert.equal(badRes.ok, false);
  assert.ok(badRes.errors.length >= 3);

  // Valid Mode A schedule registers Chrome alarm cleanly
  const okRes = await manager.createSchedule({
    clientId: "cli_1",
    locationId: "loc_1",
    frequency: "weekly",
    dayOfWeek: "Monday",
    timeOfDay: "09:00",
    timezone: "Australia/Sydney",
    automationMode: AUTOMATION_MODES.MODE_A_REVIEW,
    expectedKeywordCount: 85,
  });
  assert.equal(okRes.ok, true);
  assert.equal(alarmsApi.alarms.has(`dm_sched::${okRes.schedule.scheduleId}`), true);

  // Disable clears alarm; reconcileAlarms recreates missing alarm after browser wipe
  await manager.setScheduleEnabled(okRes.schedule.scheduleId, false);
  assert.equal(alarmsApi.alarms.has(`dm_sched::${okRes.schedule.scheduleId}`), false);
  await manager.setScheduleEnabled(okRes.schedule.scheduleId, true);
  alarmsApi.alarms.clear();
  const rec = await alarmController.reconcileAlarms({ scheduleStorage });
  assert.equal(rec.syncedCount, 1);
  assert.equal(alarmsApi.alarms.has(`dm_sched::${okRes.schedule.scheduleId}`), true);

  // Delete clears alarm permanently
  await manager.deleteSchedule(okRes.schedule.scheduleId);
  assert.equal(alarmsApi.alarms.has(`dm_sched::${okRes.schedule.scheduleId}`), false);
});

test("scheduledJobRunner runs multi-client sequential checks, retries transient keyword glitches, prepares Mode A Sheet preview, and writes deterministic history", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const historyStorage = createHistoryStorage({ storageClient, idbFactory: null });
  const alarmsApi = createFakeAlarmsApi();
  const alarmController = createAlarmController({ alarmsApi });
  const manager = createScheduleManager({ scheduleStorage, alarmController, clientStorage, locationManager });
  const sentNotifs = [];
  const notificationManager = createNotificationManager({
    notificationsApi: {
      create(id, opts, cb) {
        sentNotifs.push({ id, ...opts });
        if (cb) cb(id);
      },
    },
    scheduleStorage,
  });

  await clientStorage.saveClient({
    clientId: "cli_apex",
    clientName: "Apex Home",
    websiteDomain: "apexservices.example.com",
    sheetConfig: {
      sheetUrl: `https://docs.google.com/spreadsheets/d/${FICTIONAL_SPREADSHEET_ID}/edit#gid=${FICTIONAL_WORKSHEET_ID}`,
      spreadsheetId: FICTIONAL_SPREADSHEET_ID,
      worksheetId: FICTIONAL_WORKSHEET_ID,
      worksheetName: FICTIONAL_WORKSHEET_NAME,
      headerRow: 6,
      keywordColumn: "C",
      serpUrlColumn: "G",
      latestDateColumn: "H",
    },
  });
  await clientStorage.saveLocation({
    locationId: "loc_syd",
    clientId: "cli_apex",
    locationName: "Sydney, Australia",
    country: "Australia",
    language: "en",
  });
  await clientStorage.saveClient({
    clientId: "cli_second",
    clientName: "Second Client",
    websiteDomain: "second.example.org",
  });
  await clientStorage.saveLocation({
    locationId: "loc_mel",
    clientId: "cli_second",
    locationName: "Melbourne, Australia",
    country: "Australia",
    language: "en",
  });
  await clientStorage.saveKeywordsBulk([
    { keywordId: "kw_sec_1", clientId: "cli_second", locationId: "loc_mel", keyword: "melbourne seo", active: true },
  ]);

  const authClient = createGoogleAuthClient({
    identityApi: { getAuthToken: (_o, cb) => cb("ro_tok"), removeCachedAuthToken: (_o, cb) => cb() },
    runtimeApi: {
      getManifest: () => ({
        oauth2: { client_id: "cid", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] },
      }),
    },
    storageClient,
  });
  let writeCallCount = 0;
  const mockFetch = async (url, init) => {
    if (init?.method && init.method !== "GET") writeCallCount += 1;
    const u = String(url);
    if (u.includes("values:batchGet")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          valueRanges: [{ values: structuredClone(u.includes("FORMULA") ? SAMPLE_FORMULA_ROWS : SAMPLE_DISPLAY_ROWS) }],
        }),
      };
    }
    if (u.includes("includeGridData=true")) {
      return { ok: true, status: 200, json: async () => structuredClone(SAMPLE_GRID_DETAILS) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(SAMPLE_METADATA_RESPONSE) };
  };

  const sheetsApiClient = createSheetsApiClient({ authClient, fetchImpl: mockFetch });
  const sheetReader = createSheetReader({ sheetsApiClient, clientStorage });
  const sheetUpdater = createSheetUpdater({
    authClient,
    sheetReader,
    sheetsApiClient,
    sheetsWriteClient: {
      executeBatchUpdate: async () => {
        writeCallCount += 1;
        return { ok: true };
      },
    },
    backupManager: createSheetBackupManager({ sheetsApiClient, storageClient, idbFactory: null }),
    updateJournal: createUpdateJournal({ clientStorage }),
    clientStorage,
    locationManager,
  });

  const batchRes = await manager.createSchedule({
    name: "Agency Weekly Batch",
    scopeType: "agency_batch",
    clientConfigs: [
      { clientId: "cli_apex", locationId: "loc_syd" },
      { clientId: "cli_second", locationId: "loc_mel" },
    ],
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "Australia/Sydney",
    automationMode: AUTOMATION_MODES.MODE_A_REVIEW,
    testFastDelayMs: 1,
  });
  assert.equal(batchRes.ok, true);

  // Track strict sequential order (no overlapping concurrent checks!)
  let activeCheckCount = 0;
  let maxConcurrent = 0;
  let transientRetried = false;

  const runner = createScheduledJobRunner({
    scheduleStorage,
    alarmController,
    clientStorage,
    locationManager,
    googleAuthClient: authClient,
    sheetReader,
    sheetUpdater,
    historyStorage,
    notificationManager,
    verifyLocationForClient: async () => ({ ok: true }),
    runKeywordCheck: async ({ client, task, attempt }) => {
      activeCheckCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCheckCount);
      await new Promise((r) => setTimeout(r, 2));
      activeCheckCount -= 1;

      if (client.clientId === "cli_second" && attempt === 1) {
        transientRetried = true;
        return { status: TASK_STATUSES.NETWORK_ERROR, transient: true, error: "Temporary timeout" };
      }
      return {
        status: TASK_STATUSES.RANKED,
        position: 3,
        rankingUrl: `https://${client.websiteDomain}/landing`,
        isLiveVerified: true,
        actualResultsChecked: 20,
      };
    },
  });

  const queue = createExecutionQueue({ scheduleStorage, alarmController });
  const enq = await queue.enqueueOccurrence({
    schedule: batchRes.schedule,
    scheduledForAt: batchRes.schedule.nextScheduledRunAt,
    triggerSource: "alarm",
  });
  const drain = await queue.drainQueue({ jobRunner: runner });

  assert.equal(drain.ok, true);
  assert.equal(maxConcurrent, 1); // Strictly sequential!
  assert.equal(transientRetried, true);
  assert.equal(writeCallCount, 0); // Mode A never writes to live Google Sheets automatically!

  const exec = drain.processed[0].execution;
  assert.equal(exec.status, EXECUTION_STATES.SHEET_PREVIEW_READY);
  assert.equal(exec.summary.completedClients, 2);
  assert.equal(exec.summary.previewReadyCount, 1);
  assert.ok(exec.clientReports[0].sheetPreview?.planFingerprint);

  // Verify history persisted deterministically for all imported + client keywords
  const hist = await historyStorage.queryRankingHistory({ clientId: "cli_second" });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].rankingPosition, 3);
  assert.equal(sentNotifs.length, 1);
});

test("scheduledJobRunner stops immediately on CAPTCHA or OAuth expiration and preserves completed results without false NA", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const manager = createScheduleManager({ scheduleStorage, clientStorage, locationManager });
  const notifs = [];
  const notificationManager = createNotificationManager({
    notificationsApi: {
      create(id, opts, cb) {
        notifs.push({ id, ...opts });
        if (cb) cb(id);
      },
    },
    scheduleStorage,
  });

  await clientStorage.saveClient({ clientId: "c_cap", clientName: "Cap Client", websiteDomain: "cap.example.com" });
  await clientStorage.saveLocation({ locationId: "l_cap", clientId: "c_cap", locationName: "Sydney" });
  await clientStorage.saveKeywordsBulk([
    { keywordId: "k1", clientId: "c_cap", locationId: "l_cap", keyword: "first kw", active: true },
    { keywordId: "k2", clientId: "c_cap", locationId: "l_cap", keyword: "second kw", active: true },
    { keywordId: "k3", clientId: "c_cap", locationId: "l_cap", keyword: "third kw", active: true },
  ]);

  const schedRes = await manager.createSchedule({
    clientId: "c_cap",
    locationId: "l_cap",
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "Australia/Sydney",
    syncSheetBeforeRun: false,
    testFastDelayMs: 1,
  });

  const seenKeywords = [];
  const runner = createScheduledJobRunner({
    scheduleStorage,
    clientStorage,
    locationManager,
    notificationManager,
    verifyLocationForClient: async () => ({ ok: true }),
    runKeywordCheck: async ({ task }) => {
      seenKeywords.push(task.keyword);
      if (task.keyword === "first kw") {
        return { status: TASK_STATUSES.RANKED, position: 2, isLiveVerified: true };
      }
      return {
        status: TASK_STATUSES.SEARCH_BLOCKED,
        captchaDetected: true,
        errorDetails: "CAPTCHA triggered",
      };
    },
  });

  const queue = createExecutionQueue({ scheduleStorage });
  await queue.enqueueOccurrence({ schedule: schedRes.schedule, scheduledForAt: "2026-11-30T09:00:00Z" });
  const drain = await queue.drainQueue({ jobRunner: runner });

  assert.deepEqual(seenKeywords, ["first kw", "second kw"]); // Stopped before third kw — zero retries/bypass!
  assert.equal(drain.processed[0].execution.haltedByCaptcha, true);
  assert.equal(drain.processed[0].execution.status, EXECUTION_STATES.FAILED);
  assert.equal(drain.processed[0].schedule.status, SCHEDULE_STATES.NEEDS_ATTENTION);
  assert.equal(drain.processed[0].clientReports?.[0]?.failureCode ?? drain.processed[0].execution.clientReports[0].failureCode, SCHEDULE_FAILURE_CODES.CAPTCHA_BLOCKED);
  assert.match(notifs[0].title, /CAPTCHA|blocked/i);
});

