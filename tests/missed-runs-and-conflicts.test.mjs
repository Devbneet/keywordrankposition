import assert from "node:assert/strict";
import test from "node:test";
import { handleAlarmEvent, handleRuntimeMessage, reconcileSchedulerOnStartup } from "../background/service-worker.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createNotificationManager } from "../modules/notifications/notification-manager.js";
import { alarmNameForSchedule, createAlarmController } from "../modules/scheduler/alarm-controller.js";
import { createExecutionQueue } from "../modules/scheduler/execution-queue.js";
import { createMissedRunRecovery } from "../modules/scheduler/missed-run-recovery.js";
import { createScheduleManager } from "../modules/scheduler/schedule-manager.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";
import { createScheduledJobRunner } from "../modules/scheduler/scheduled-job-runner.js";
import {
  EXECUTION_STATES,
  LOCK_TYPES,
  MISSED_RUN_POLICIES,
  SCHEDULE_STATES,
} from "../modules/scheduler/scheduler-state.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

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

test("executionQueue deduplicates duplicate alarm triggers and defers safely when manual/sheet locks exist", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const alarmsApi = createFakeAlarmsApi();
  const alarmController = createAlarmController({ alarmsApi });
  const manager = createScheduleManager({ scheduleStorage, alarmController, clientStorage, locationManager });

  await clientStorage.saveClient({ clientId: "c1", clientName: "Client One", websiteDomain: "one.example.com" });
  await clientStorage.saveLocation({ locationId: "l1", clientId: "c1", locationName: "Sydney" });
  await clientStorage.saveKeywordsBulk([{ keywordId: "k1", clientId: "c1", locationId: "l1", keyword: "plumber", active: true }]);

  const schedRes = await manager.createSchedule({
    clientId: "c1",
    locationId: "l1",
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "UTC",
    syncSheetBeforeRun: false,
    isAuthorized: true,
    testFastDelayMs: 1,
  });

  const queue = createExecutionQueue({ scheduleStorage, alarmController });
  const slotIso = schedRes.schedule.nextScheduledRunAt;

  // Duplicate alarms for exact same scheduled slot deduplicate cleanly!
  const first = await queue.enqueueOccurrence({ schedule: schedRes.schedule, scheduledForAt: slotIso, triggerSource: "alarm" });
  const second = await queue.enqueueOccurrence({ schedule: schedRes.schedule, scheduledForAt: slotIso, triggerSource: "alarm" });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.execution.executionId, second.execution.executionId);

  // Simulate active manual / Sheet write lock blocking scheduled execution
  await scheduleStorage.acquireExecutionLock({
    lockType: LOCK_TYPES.MANUAL_BULK,
    ownerId: "manual_job_99",
    description: "User manual bulk job",
  });

  let runCalls = 0;
  const runner = createScheduledJobRunner({
    scheduleStorage,
    alarmController,
    clientStorage,
    locationManager,
    verifyLocationForClient: async () => ({ ok: true }),
    runKeywordCheck: async () => {
      runCalls += 1;
      return { status: TASK_STATUSES.RANKED, position: 1, isLiveVerified: true };
    },
  });

  const deferredDrain = await queue.drainQueue({ jobRunner: runner });
  assert.equal(deferredDrain.deferredCount, 1);
  assert.equal(runCalls, 0);
  assert.equal(alarmsApi.alarms.has("dm_queue_drain"), true);

  // Release manual lock -> queued run executes smoothly!
  await scheduleStorage.releaseExecutionLock("manual_job_99");
  const resumedDrain = await queue.drainQueue({ jobRunner: runner });
  assert.equal(resumedDrain.processedCount, 1);
  assert.equal(runCalls, 1);
});

test("missedRunRecovery supports ask_user, run_latest (single catchup without bursts), skip, and resolution actions", async () => {
  const storageClient = createInMemoryStorage();
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const alarmsApi = createFakeAlarmsApi();
  const alarmController = createAlarmController({ alarmsApi });
  const executionQueue = createExecutionQueue({ scheduleStorage, alarmController });
  const notifications = [];
  const notificationManager = createNotificationManager({
    notificationsApi: {
      create(id, opts, cb) {
        notifications.push({ id, ...opts });
        if (cb) cb(id);
      },
    },
    scheduleStorage,
  });
  const recovery = createMissedRunRecovery({ scheduleStorage, alarmController, executionQueue, notificationManager });

  // 1. ask_user policy logs MISSED_PENDING + notifies user + advances nextScheduledRunAt
  await scheduleStorage.saveSchedule({
    scheduleId: "s_ask",
    name: "Ask User Sched",
    clientId: "c1",
    scopeType: "single_client",
    enabled: true,
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "UTC",
    missedRunPolicy: MISSED_RUN_POLICIES.ASK_USER,
    nextScheduledRunAt: "2026-11-02T09:00:00.000Z",
  });

  // 2. run_latest policy enqueues only latest occurrence even if 2 occurrences were missed!
  await scheduleStorage.saveSchedule({
    scheduleId: "s_latest",
    name: "Run Latest Sched",
    clientId: "c2",
    scopeType: "single_client",
    enabled: true,
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "11:00",
    timezone: "UTC",
    missedRunPolicy: MISSED_RUN_POLICIES.RUN_LATEST,
    nextScheduledRunAt: "2026-11-02T11:00:00.000Z",
  });

  // 3. skip policy marks Skipped cleanly
  await scheduleStorage.saveSchedule({
    scheduleId: "s_skip",
    name: "Skip Sched",
    clientId: "c3",
    scopeType: "single_client",
    enabled: true,
    frequency: "weekly",
    dayOfWeek: 1,
    timeOfDay: "12:00",
    timezone: "UTC",
    missedRunPolicy: MISSED_RUN_POLICIES.SKIP,
    nextScheduledRunAt: "2026-11-02T12:00:00.000Z",
  });

  const now = new Date("2026-11-11T15:00:00.000Z"); // 2 Mondays elapsed (Nov 2 & Nov 9)
  const res = await recovery.checkAndHandleMissedRuns({ now });
  assert.equal(res.missedHandledCount, 3);

  const missedExecs = await scheduleStorage.listMissedExecutions();
  assert.equal(missedExecs.length, 1);
  assert.equal(missedExecs[0].scheduleId, "s_ask");
  assert.equal(missedExecs[0].missedCount, 2);
  assert.equal(notifications.length, 1);

  const updatedAsk = await scheduleStorage.getSchedule("s_ask");
  assert.equal(updatedAsk.status, SCHEDULE_STATES.MISSED);
  assert.equal(updatedAsk.nextScheduledRunAt, "2026-11-16T09:00:00.000Z");

  // Resolve ask_user via 'skip'
  const resolved = await recovery.resolveMissedExecution({
    executionId: missedExecs[0].executionId,
    action: "skip",
  });
  assert.equal(resolved.action, "skipped");
  assert.equal((await scheduleStorage.getSchedule("s_ask")).status, SCHEDULE_STATES.ENABLED);

  // Confirm run_latest queued ONLY 1 item (for Nov 9 latest slot), zero burst flooding!
  const queued = await executionQueue.listQueuedExecutions();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].scheduleId, "s_latest");
  assert.equal(queued[0].scheduledForAt, "2026-11-09T11:00:00.000Z");

  const skipExecs = await scheduleStorage.listExecutions({ scheduleId: "s_skip" });
  assert.equal(skipExecs[0].status, EXECUTION_STATES.SKIPPED);
});

test("service worker routes SCHEDULE_* messages, reconciles alarms on startup, and deduplicates chrome.alarms.onAlarm triggers", async () => {
  const storageClient = createInMemoryStorage();
  const alarmsApi = createFakeAlarmsApi();
  const chromeApi = {
    storage: { local: storageClient },
    alarms: alarmsApi,
    runtime: { getManifest: () => ({ version: "0.1.0" }) },
  };

  // Seed client + location + schedule via runtime messages
  const cliRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.CLIENT_CREATE,
      payload: { clientName: "SW Client", websiteDomain: "sw.example.com" },
    },
    null,
    chromeApi
  );
  assert.equal(cliRes.ok, true);

  const locRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.CLIENT_ADD_LOCATION,
      payload: {
        clientId: cliRes.client.clientId,
        locationName: "Sydney",
        city: "Sydney",
        latitude: -33.8688,
        longitude: 151.2093,
        country: "Australia",
        language: "en",
      },
    },
    null,
    chromeApi
  );
  assert.equal(locRes.ok, true);

  const createRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.SCHEDULE_CREATE,
      payload: {
        name: "SW Weekly",
        clientId: cliRes.client.clientId,
        locationId: locRes.location.locationId,
        frequency: "weekly",
        dayOfWeek: 1,
        timeOfDay: "09:00",
        timezone: "Australia/Sydney",
      },
    },
    null,
    chromeApi
  );
  assert.equal(createRes.ok, true);

  const summaryRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.SCHEDULE_SUMMARY }, null, chromeApi);
  assert.equal(summaryRes.ok, true);
  assert.equal(summaryRes.kpis.activeSchedulesCount, 1);

  // Wipe alarms -> startup reconciliation recreates it
  alarmsApi.alarms.clear();
  const recRes = await reconcileSchedulerOnStartup(chromeApi);
  assert.equal(recRes.ok, true);
  assert.equal(alarmsApi.alarms.has(alarmNameForSchedule(createRes.schedule.scheduleId)), true);

  // Fire alarm twice -> second is cleanly deduplicated
  const alarmPayload = { name: alarmNameForSchedule(createRes.schedule.scheduleId), scheduledTime: Date.now() };
  const fire1 = await handleAlarmEvent(alarmPayload, chromeApi);
  const fire2 = await handleAlarmEvent(alarmPayload, chromeApi);
  assert.equal(fire1.deduplicated, false);
  assert.equal(fire2.deduplicated, true);
});

