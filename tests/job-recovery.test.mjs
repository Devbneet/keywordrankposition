import test from "node:test";
import assert from "node:assert/strict";

import { createJobManager } from "../modules/jobs/job-manager.js";
import { recoverInterruptedJob } from "../modules/jobs/job-recovery.js";
import { JOB_STATES, TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { createStorageClient } from "../modules/storage/storage.js";

function createMemoryStorageClient() {
  const store = new Map();
  return createStorageClient({
    async get(keys) {
      if (typeof keys === "string") {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
      }
    },
  });
}

test("recovers interrupted Running job on extension reload and resets mid-flight task to Pending", async () => {
  const storageClient = createMemoryStorageClient();
  const jobStorage = createJobStorage({ storageClient });

  const job = {
    jobId: "bulk_crash_1",
    state: JOB_STATES.RUNNING,
    clientDomain: "example.com",
    locationConfig: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093 },
    requestedDepth: 50,
    totalKeywords: 3,
    currentKeyword: "kw 2",
    createdAt: "2026-11-26T10:00:00Z",
  };
  const tasks = [
    {
      taskId: "t1",
      jobId: "bulk_crash_1",
      sequenceIndex: 0,
      rowPosition: 1,
      keyword: "kw 1",
      clientDomain: "example.com",
      requestedDepth: 50,
      status: TASK_STATUSES.RANKED,
      position: 4,
      rankingUrl: "https://example.com/1",
      checkedResults: 10,
    },
    {
      taskId: "t2",
      jobId: "bulk_crash_1",
      sequenceIndex: 1,
      rowPosition: 2,
      keyword: "kw 2",
      clientDomain: "example.com",
      requestedDepth: 50,
      status: TASK_STATUSES.RUNNING,
      position: null,
      rankingUrl: null,
      checkedResults: 0,
    },
    {
      taskId: "t3",
      jobId: "bulk_crash_1",
      sequenceIndex: 2,
      rowPosition: 3,
      keyword: "kw 3",
      clientDomain: "example.com",
      requestedDepth: 50,
      status: TASK_STATUSES.PENDING,
      position: null,
      rankingUrl: null,
      checkedResults: 0,
    },
  ];

  await jobStorage.saveJobMetadata(job);
  await jobStorage.saveTaskBatch("bulk_crash_1", tasks);

  // Simulate service worker / dashboard reload
  const reloadedStorage = createJobStorage({ storageClient });
  const recovery = await recoverInterruptedJob({ jobStorage: reloadedStorage });

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.job.state, JOB_STATES.RECOVERY_REQUIRED);
  assert.equal(recovery.tasks[0].status, TASK_STATUSES.RANKED);
  assert.equal(recovery.tasks[0].position, 4);
  assert.equal(recovery.tasks[1].status, TASK_STATUSES.PENDING);
  assert.equal(recovery.tasks[2].status, TASK_STATUSES.PENDING);
});

test("prevents duplicate simultaneous jobs and requires fresh location verification on resume", async () => {
  const storageClient = createMemoryStorageClient();
  const jobStorage = createJobStorage({ storageClient });

  let locationOk = true;
  const mockLocationController = {
    async getStatus() {
      if (!locationOk) {
        return {
          config: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093 },
          tabId: null,
          debuggerAttached: false,
          browserGpsStatus: "Debugger disconnected",
          googleLocationStatus: "Unverified",
          lastError: "Debugger disconnected.",
        };
      }
      return {
        config: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093 },
        tabId: 10,
        debuggerAttached: true,
        browserGpsStatus: "GPS verified",
        googleLocationStatus: "Google location matched",
        googleDetectedLocation: "Sydney NSW",
        googleLocationSource: "From your device",
      };
    },
  };

  let resolveFirstCheck;
  let callIdx = 0;
  const slowChecker = {
    async checkRanking({ keyword }) {
      callIdx += 1;
      if (callIdx === 1) {
        await new Promise((resolve) => {
          resolveFirstCheck = resolve;
        });
      }
      return {
        ok: true,
        result: {
          keyword,
          status: "Ranked",
          position: 2,
          rankingUrl: "https://example.com/",
          checkedResults: 10,
          isLiveVerified: true,
          durationMs: 120,
          checkedAt: new Date().toISOString(),
        },
      };
    },
    async stopCheck() {},
  };

  const manager = createJobManager({
    jobStorage,
    locationController: mockLocationController,
    singleKeywordChecker: slowChecker,
  });

  // Start first job and leave it awaiting first keyword
  const firstPromise = manager.startJob({
    websiteDomain: "example.com",
    keywords: ["kw 1", "kw 2"],
    searchDepth: 10,
    isAuthorized: true,
  });

  await new Promise((r) => setTimeout(r, 20));
  // Attempt to start duplicate job simultaneously
  const dupRes = await manager.startJob({
    websiteDomain: "example.com",
    keywords: ["kw 3"],
    searchDepth: 10,
    isAuthorized: true,
  });
  assert.equal(dupRes.ok, false);
  assert.match(dupRes.error, /already running/i);

  // Pause while first keyword is finishing, then finish first keyword
  await manager.pauseJob();
  resolveFirstCheck();
  const pausedOutcome = await firstPromise;
  assert.equal(pausedOutcome.job.state, JOB_STATES.PAUSED);

  // Lose location verification before resuming -> resume must refuse and flag failure
  locationOk = false;
  const blockedResume = await manager.resumeJob();
  assert.equal(blockedResume.ok, false);
  assert.equal(blockedResume.job.state, JOB_STATES.LOCATION_VERIFICATION_FAILED);

  // Restore location verification -> resume completes remaining kw 2
  locationOk = true;
  const resumed = await manager.resumeJob();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.job.state, JOB_STATES.COMPLETED);
  assert.equal(resumed.tasks[1].status, TASK_STATUSES.RANKED);
});

test("saveTaskBatch prevents duplicate task records across updates", async () => {
  const storageClient = createMemoryStorageClient();
  const jobStorage = createJobStorage({ storageClient });

  const task = {
    taskId: "t1",
    jobId: "j_dedupe",
    sequenceIndex: 0,
    rowPosition: 1,
    keyword: "seo",
    status: TASK_STATUSES.PENDING,
  };
  await jobStorage.saveTaskResult(task);
  await jobStorage.saveTaskResult({ ...task, status: TASK_STATUSES.RANKED, position: 3 });

  const loaded = await jobStorage.loadTasksForJob("j_dedupe");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].status, TASK_STATUSES.RANKED);
  assert.equal(loaded[0].position, 3);
});

