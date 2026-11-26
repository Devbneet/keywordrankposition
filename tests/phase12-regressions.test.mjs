import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createHistoryStorage } from "../modules/history/history-storage.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createExecutionQueue } from "../modules/scheduler/execution-queue.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";
import { createScheduledJobRunner } from "../modules/scheduler/scheduled-job-runner.js";
import {
  EXECUTION_STATES,
  SCHEDULE_FAILURE_CODES,
} from "../modules/scheduler/scheduler-state.js";

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

test("Phase 12: never falls back to first location when explicit locationId is missing, and requires explicit authorization", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });

  await clientStorage.saveClient({
    clientId: "c_p12",
    clientName: "P12 Client",
    websiteDomain: "p12.example.com",
  });
  await clientStorage.saveLocation({
    locationId: "loc_other",
    clientId: "c_p12",
    locationName: "Melbourne",
    country: "Australia",
    language: "en",
  });
  await clientStorage.saveKeywordsBulk([
    { keywordId: "k1", clientId: "c_p12", keyword: "seo", active: true },
  ]);

  // 1. Missing explicit authorization -> blocked
  await scheduleStorage.saveSchedule({
    scheduleId: "s_unauth",
    name: "Unauth",
    clientId: "c_p12",
    locationId: "loc_other",
    scopeType: "single_client",
    enabled: true,
    isAuthorized: false,
    syncSheetBeforeRun: false,
  });

  const runner = createScheduledJobRunner({
    scheduleStorage,
    clientStorage,
    locationManager,
    verifyLocationForClient: async () => ({ ok: true }),
    runKeywordCheck: async () => ({ status: TASK_STATUSES.RANKED, position: 1, isLiveVerified: true }),
  });

  const resUnauth = await runner.runExecution({
    executionId: "ex_unauth",
    scheduleId: "s_unauth",
    scheduledForAt: "2026-11-30T09:00:00Z",
  });
  assert.equal(resUnauth.execution.clientReports[0].failureCode, SCHEDULE_FAILURE_CODES.AUTH_EXPIRED);

  // 2. Explicit locationId deleted -> must NOT fall back to loc_other!
  await scheduleStorage.saveSchedule({
    scheduleId: "s_missing_loc",
    name: "Missing Loc",
    clientId: "c_p12",
    locationId: "loc_deleted_99",
    scopeType: "single_client",
    enabled: true,
    isAuthorized: true,
    syncSheetBeforeRun: false,
  });

  const resMissingLoc = await runner.runExecution({
    executionId: "ex_missing_loc",
    scheduleId: "s_missing_loc",
    scheduledForAt: "2026-11-30T09:00:00Z",
  });
  assert.equal(resMissingLoc.execution.clientReports[0].failureCode, SCHEDULE_FAILURE_CODES.MISSING_LOCATION);
});

test("Phase 12: persists each keyword immediately, never defaults verification to Verified, and halts on debugger disconnect", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const historyStorage = createHistoryStorage({ storageClient, idbFactory: null });

  await clientStorage.saveClient({ clientId: "c_imm", clientName: "Imm", websiteDomain: "imm.example.com" });
  await clientStorage.saveLocation({ locationId: "l_imm", clientId: "c_imm", locationName: "Sydney" });
  await clientStorage.saveKeywordsBulk([
    { keywordId: "k1", clientId: "c_imm", locationId: "l_imm", keyword: "kw one", active: true },
    { keywordId: "k2", clientId: "c_imm", locationId: "l_imm", keyword: "kw two", active: true },
  ]);

  await scheduleStorage.saveSchedule({
    scheduleId: "s_imm",
    name: "Imm Sched",
    clientId: "c_imm",
    locationId: "l_imm",
    scopeType: "single_client",
    enabled: true,
    isAuthorized: true,
    syncSheetBeforeRun: false,
    testFastDelayMs: 1,
  });

  let savedBeforeSecondKeyword = 0;
  const runner = createScheduledJobRunner({
    scheduleStorage,
    clientStorage,
    locationManager,
    historyStorage,
    verifyLocationForClient: async () => ({ ok: true }),
    runKeywordCheck: async ({ task }) => {
      if (task.keyword === "kw one") {
        return {
          status: TASK_STATUSES.RANKED,
          position: 4,
          isLiveVerified: true,
          browserGpsVerification: null,
          googleLocationVerification: null,
        };
      }
      // Verify kw one was ALREADY persisted before kw two even runs!
      const soFar = await historyStorage.queryRankingHistory({ clientId: "c_imm" });
      savedBeforeSecondKeyword = soFar.length;
      return {
        status: TASK_STATUSES.LOCATION_UNVERIFIED,
        debuggerDisconnected: true,
        errorDetails: "Debugger detached",
      };
    },
  });

  const res = await runner.runExecution({
    executionId: "ex_imm",
    scheduleId: "s_imm",
    scheduledForAt: "2026-11-30T09:00:00Z",
  });
  assert.equal(savedBeforeSecondKeyword, 1);
  assert.equal(res.execution.clientReports[0].haltedByLocation, true);

  const allHist = await historyStorage.queryRankingHistory({ clientId: "c_imm" });
  const kw1 = allHist.find((h) => h.keywordText === "kw one");
  assert.equal(kw1.browserGpsVerification, null);
  assert.equal(kw1.googleLocationVerification, null);
});

test("Phase 12: atomic claimExecution prevents duplicate concurrent execution and queue prevents infinite loops", async () => {
  const storageClient = createInMemoryStorage();
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const queue = createExecutionQueue({ scheduleStorage });

  await scheduleStorage.saveExecution({
    executionId: "ex_atomic_1",
    executionKey: "s1::2026-11-30T09:00:00Z",
    scheduleId: "s1",
    status: EXECUTION_STATES.QUEUED,
    queuedAt: "2026-11-30T09:00:00Z",
  });

  const c1 = await scheduleStorage.claimExecution("ex_atomic_1", "worker_A");
  const c2 = await scheduleStorage.claimExecution("ex_atomic_1", "worker_B");
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, false);
  assert.equal(c2.alreadyClaimed, true);

  // Queue loop protection when jobRunner returns ok:false
  await scheduleStorage.saveExecution({
    executionId: "ex_loop_1",
    executionKey: "s_missing::2026-11-30T09:00:00Z",
    scheduleId: "s_missing",
    status: EXECUTION_STATES.QUEUED,
    queuedAt: "2026-11-30T09:00:01Z",
  });

  const drainRes = await queue.drainQueue({
    jobRunner: {
      runExecution: async () => ({ ok: false, error: "Missing schedule" }),
    },
  });
  assert.equal(drainRes.ok, true);
  assert.equal(drainRes.processedCount, 1);
  const failedExec = await scheduleStorage.getExecution("ex_loop_1");
  assert.equal(failedExec.status, EXECUTION_STATES.FAILED);
});

