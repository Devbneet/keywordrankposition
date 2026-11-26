/**
 * Bulk ranking job lifecycle manager (start, pause, resume, stop, retry failed,
 * clear, recovery, and status retrieval).
 */

import { normalizeDomain } from "../ranking/domain-matcher.js";
import { SUPPORTED_SEARCH_DEPTHS } from "../ranking/ranking-state.js";
import { createBulkRankingRunner } from "./bulk-ranking-runner.js";
import { recoverInterruptedJob } from "./job-recovery.js";
import { isActiveJobState, isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "./job-state.js";
import { buildKeywordQueue } from "./keyword-queue.js";

export function createJobManager({
  jobStorage,
  locationController,
  singleKeywordChecker,
  onProgress = null,
}) {
  const runner = createBulkRankingRunner({
    jobStorage,
    locationController,
    singleKeywordChecker,
    onProgress,
  });

  async function getStatus() {
    const recovery = await recoverInterruptedJob({ jobStorage });
    return {
      ok: true,
      recovered: recovery.recovered,
      job: recovery.job,
      tasks: recovery.tasks,
      isBusy: runner.isBusy(),
    };
  }

  async function startJob({
    websiteDomain,
    keywords,
    searchDepth = 50,
    deviceType = "Desktop",
  } = {}) {
    if (runner.isBusy()) {
      return { ok: false, error: "A bulk ranking job is already running." };
    }

    const activeStored = await jobStorage.loadActiveJob();
    if (activeStored && isActiveJobState(activeStored.state)) {
      return { ok: false, error: "An active bulk job already exists. Recover, pause, or stop it first." };
    }

    const cleanDomain = normalizeDomain(websiteDomain);
    if (!cleanDomain) {
      return { ok: false, error: "Please enter a valid target website domain." };
    }

    const depth = Number(searchDepth) || 50;
    if (!SUPPORTED_SEARCH_DEPTHS.includes(depth)) {
      return { ok: false, error: `Search depth must be one of ${SUPPORTED_SEARCH_DEPTHS.join(", ")}.` };
    }

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return { ok: false, error: "Please provide at least one keyword." };
    }

    // Validate active location session before creating the queue
    const locCheck = await runner.verifyLocationIntegrity(null);
    if (!locCheck.ok) {
      return {
        ok: false,
        error: locCheck.error,
        jobState: locCheck.jobState,
      };
    }

    const config = locCheck.liveLocation.config;
    const jobId = `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const queue = buildKeywordQueue({
      jobId,
      keywords,
      clientDomain: cleanDomain,
      locationConfig: config,
      searchDepth: depth,
    });

    if (queue.length === 0) {
      return { ok: false, error: "Keyword list contains no non-empty keywords." };
    }

    const initialJob = {
      jobId,
      state: JOB_STATES.VALIDATING,
      clientDomain: cleanDomain,
      locationConfig: { ...config },
      requestedDepth: depth,
      deviceType: String(deviceType || "Desktop"),
      totalKeywords: queue.length,
      currentKeyword: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      lastError: null,
    };

    const metaSave = await jobStorage.saveJobMetadata(initialJob);
    if (!metaSave.ok) {
      return { ok: false, error: metaSave.error, quotaExceeded: metaSave.quotaExceeded };
    }

    const batchSave = await jobStorage.saveTaskBatch(jobId, queue);
    if (!batchSave.ok) {
      return { ok: false, error: batchSave.error, quotaExceeded: batchSave.quotaExceeded };
    }

    return runner.processQueue({
      job: initialJob,
      tasks: queue,
      expectedConfig: config,
    });
  }

  async function pauseJob() {
    if (runner.isBusy()) {
      runner.requestPause();
      return { ok: true, message: "Pause requested; stopping after current keyword." };
    }
    return { ok: false, error: "No running bulk job to pause." };
  }

  async function stopJob() {
    if (runner.isBusy()) {
      runner.requestStop();
      return { ok: true, message: "Stop requested." };
    }
    const job = await jobStorage.loadActiveJob();
    if (job && (job.state === JOB_STATES.PAUSED || job.state === JOB_STATES.RECOVERY_REQUIRED)) {
      const stoppedJob = {
        ...job,
        state: JOB_STATES.STOPPED,
        currentKeyword: null,
        completedAt: new Date().toISOString(),
      };
      await jobStorage.saveJobMetadata(stoppedJob);
      const tasks = await jobStorage.loadTasksForJob(job.jobId);
      return { ok: true, job: stoppedJob, tasks };
    }
    return { ok: false, error: "No active or paused bulk job to stop." };
  }

  async function resumeJob() {
    if (runner.isBusy()) {
      return { ok: false, error: "Bulk job is already running." };
    }

    const job = await jobStorage.loadActiveJob();
    if (!job) {
      return { ok: false, error: "No saved bulk job found to resume." };
    }

    const tasks = await jobStorage.loadTasksForJob(job.jobId);
    const hasPending = tasks.some((t) => t.status === TASK_STATUSES.PENDING);
    if (!hasPending) {
      return { ok: false, error: "No pending keywords left in the saved job." };
    }

    // Revalidate configured client location before resuming
    const locCheck = await runner.verifyLocationIntegrity(job.locationConfig);
    if (!locCheck.ok) {
      const failedJob = {
        ...job,
        state: locCheck.jobState,
        lastError: locCheck.error,
      };
      await jobStorage.saveJobMetadata(failedJob);
      return { ok: false, error: locCheck.error, job: failedJob, tasks };
    }

    return runner.processQueue({
      job: { ...job, lastError: null },
      tasks,
      expectedConfig: job.locationConfig,
    });
  }

  async function retryFailedKeywords() {
    if (runner.isBusy()) {
      return { ok: false, error: "Cannot retry while a bulk job is running." };
    }

    const job = await jobStorage.loadActiveJob();
    if (!job) {
      return { ok: false, error: "No saved bulk job found." };
    }

    const tasks = await jobStorage.loadTasksForJob(job.jobId);
    let retryCount = 0;
    const resetTasks = tasks.map((t) => {
      if (isFailedTaskStatus(t.status)) {
        retryCount += 1;
        return {
          ...t,
          status: TASK_STATUSES.PENDING,
          errorDetails: null,
        };
      }
      return t;
    });

    if (retryCount === 0) {
      return { ok: false, error: "No failed keywords to retry." };
    }

    const locCheck = await runner.verifyLocationIntegrity(job.locationConfig);
    if (!locCheck.ok) {
      return { ok: false, error: locCheck.error, job, tasks };
    }

    await jobStorage.saveTaskBatch(job.jobId, resetTasks);
    return runner.processQueue({
      job: { ...job, completedAt: null, lastError: null },
      tasks: resetTasks,
      expectedConfig: job.locationConfig,
    });
  }

  async function clearResults() {
    if (runner.isBusy()) {
      return { ok: false, error: "Stop the running job before clearing results." };
    }
    await jobStorage.clearActiveJob();
    return { ok: true, job: null, tasks: [] };
  }

  return {
    getStatus,
    startJob,
    pauseJob,
    resumeJob,
    stopJob,
    retryFailedKeywords,
    clearResults,
  };
}

