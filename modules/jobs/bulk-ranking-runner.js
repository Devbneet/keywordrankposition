/**
 * Sequential bulk keyword ranking runner built on top of SingleKeywordChecker
 * and GeolocationController. Handles pause, resume, stop, CAPTCHA halts,
 * location re-verification, and immediate per-keyword persistence.
 */

import { GOOGLE_LOCATION_STATUSES, hasConfigChanged, LOCATION_STATES } from "../location/location-state.js";
import { RANKING_STATUSES } from "../ranking/ranking-state.js";
import { isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "./job-state.js";

function mapRankingStatusToTaskStatus(rankingStatus) {
  switch (rankingStatus) {
    case RANKING_STATUSES.RANKED:
      return TASK_STATUSES.RANKED;
    case RANKING_STATUSES.NOT_FOUND:
      return TASK_STATUSES.NOT_FOUND;
    case RANKING_STATUSES.SEARCH_BLOCKED:
      return TASK_STATUSES.SEARCH_BLOCKED;
    case RANKING_STATUSES.LOCATION_MISMATCH:
      return TASK_STATUSES.LOCATION_MISMATCH;
    case RANKING_STATUSES.LOCATION_UNVERIFIED:
    case RANKING_STATUSES.PERMISSION_DENIED:
      return TASK_STATUSES.LOCATION_UNVERIFIED;
    case RANKING_STATUSES.NETWORK_ERROR:
      return TASK_STATUSES.NETWORK_ERROR;
    case RANKING_STATUSES.PARSING_ERROR:
      return TASK_STATUSES.PARSING_ERROR;
    case RANKING_STATUSES.STOPPED_BY_USER:
      return TASK_STATUSES.STOPPED;
    default:
      return TASK_STATUSES.INCOMPLETE_SEARCH;
  }
}

export function createBulkRankingRunner({
  jobStorage,
  locationController,
  singleKeywordChecker,
  onProgress = null,
}) {
  let activeRunJobId = null;
  let pauseRequested = false;
  let stopRequested = false;

  function isBusy() {
    return activeRunJobId !== null;
  }

  function requestPause() {
    if (!activeRunJobId) return false;
    pauseRequested = true;
    return true;
  }

  function requestStop() {
    if (!activeRunJobId) return false;
    stopRequested = true;
    if (singleKeywordChecker?.stopCheck) {
      singleKeywordChecker.stopCheck().catch(() => {});
    }
    return true;
  }

  async function verifyLocationIntegrity(expectedConfig) {
    const liveLocation = await locationController.getStatus({ reverifyGps: true });
    if (!liveLocation || !liveLocation.config || !liveLocation.debuggerAttached || liveLocation.tabId === null) {
      return {
        ok: false,
        taskStatus: TASK_STATUSES.LOCATION_UNVERIFIED,
        jobState: JOB_STATES.LOCATION_VERIFICATION_FAILED,
        error: liveLocation?.lastError || "Active debugger/location session was lost.",
        liveLocation,
      };
    }

    if (expectedConfig && hasConfigChanged(expectedConfig, liveLocation.config)) {
      return {
        ok: false,
        taskStatus: TASK_STATUSES.LOCATION_MISMATCH,
        jobState: JOB_STATES.LOCATION_VERIFICATION_FAILED,
        error: "Configured client location changed during the bulk job.",
        liveLocation,
      };
    }

    if (liveLocation.browserGpsStatus === LOCATION_STATES.PERMISSION_DENIED) {
      return {
        ok: false,
        taskStatus: TASK_STATUSES.LOCATION_UNVERIFIED,
        jobState: JOB_STATES.LOCATION_VERIFICATION_FAILED,
        error: liveLocation.lastError || "Browser location permission denied.",
        liveLocation,
      };
    }

    if (liveLocation.browserGpsStatus !== LOCATION_STATES.GPS_VERIFIED) {
      return {
        ok: false,
        taskStatus: TASK_STATUSES.LOCATION_MISMATCH,
        jobState: JOB_STATES.LOCATION_VERIFICATION_FAILED,
        error: liveLocation.lastError || `Browser GPS status is '${liveLocation.browserGpsStatus}'.`,
        liveLocation,
      };
    }

    if (liveLocation.googleLocationStatus === GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED) {
      return {
        ok: false,
        taskStatus: TASK_STATUSES.SEARCH_BLOCKED,
        jobState: JOB_STATES.SEARCH_BLOCKED,
        error: liveLocation.lastError || "Google Search access blocked.",
        liveLocation,
      };
    }

    if (liveLocation.googleLocationStatus !== GOOGLE_LOCATION_STATUSES.MATCHED) {
      return {
        ok: false,
        taskStatus:
          liveLocation.googleLocationStatus === GOOGLE_LOCATION_STATUSES.MISMATCH
            ? TASK_STATUSES.LOCATION_MISMATCH
            : TASK_STATUSES.LOCATION_UNVERIFIED,
        jobState: JOB_STATES.LOCATION_VERIFICATION_FAILED,
        error: liveLocation.lastError || `Google location status is '${liveLocation.googleLocationStatus}'.`,
        liveLocation,
      };
    }

    return { ok: true, liveLocation };
  }

  async function processQueue({ job, tasks, expectedConfig }) {
    if (activeRunJobId !== null) {
      return {
        ok: false,
        error: `Job '${activeRunJobId}' is already running. Pause or stop it first.`,
      };
    }

    activeRunJobId = job.jobId;
    pauseRequested = false;
    stopRequested = false;

    let currentJob = {
      ...job,
      state: JOB_STATES.RUNNING,
      lastError: null,
      interruptionReason: null,
    };
    const metaSave = await jobStorage.saveJobMetadata(currentJob);
    if (!metaSave.ok) {
      activeRunJobId = null;
      return { ok: false, error: metaSave.error, quotaExceeded: metaSave.quotaExceeded };
    }

    let currentTasks = [...tasks];

    try {
      for (let i = 0; i < currentTasks.length; i += 1) {
        const task = currentTasks[i];
        if (task.status !== TASK_STATUSES.PENDING) {
          continue;
        }

        if (stopRequested) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.STOPPED,
            currentKeyword: null,
            completedAt: new Date().toISOString(),
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: false, job: currentJob, tasks: currentTasks };
        }

        if (pauseRequested) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.PAUSED,
            currentKeyword: null,
            pausedAt: new Date().toISOString(),
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: true, paused: true, job: currentJob, tasks: currentTasks };
        }

        // Verify location integrity before every keyword check
        const locCheck = await verifyLocationIntegrity(expectedConfig);
        if (!locCheck.ok) {
          const failedTask = {
            ...task,
            status: locCheck.taskStatus,
            locationVerificationStatus: locCheck.liveLocation?.googleLocationStatus || locCheck.taskStatus,
            checkedAt: new Date().toISOString(),
            errorDetails: locCheck.error,
          };
          currentTasks[i] = failedTask;
          await jobStorage.saveTaskResult(failedTask);

          currentJob = {
            ...currentJob,
            state: locCheck.jobState,
            currentKeyword: null,
            lastError: locCheck.error,
          };
          await jobStorage.saveJobMetadata(currentJob);
          if (onProgress) onProgress({ job: currentJob, tasks: currentTasks });
          return { ok: false, error: locCheck.error, job: currentJob, tasks: currentTasks };
        }

        // Mark task running
        currentJob = { ...currentJob, currentKeyword: task.keyword };
        const runningTask = { ...task, status: TASK_STATUSES.RUNNING };
        currentTasks[i] = runningTask;
        await jobStorage.saveJobMetadata(currentJob);
        await jobStorage.saveTaskResult(runningTask);
        if (onProgress) onProgress({ job: currentJob, tasks: currentTasks });

        // Run SingleKeywordChecker
        const checkRes = await singleKeywordChecker.checkRanking({
          websiteDomain: task.clientDomain,
          keyword: task.keyword,
          searchDepth: task.requestedDepth,
          deviceType: currentJob.deviceType || "Desktop",
        });

        const r = checkRes?.result;
        const mappedStatus = r
          ? mapRankingStatusToTaskStatus(r.status)
          : TASK_STATUSES.INCOMPLETE_SEARCH;

        const completedTask = {
          ...runningTask,
          status: mappedStatus,
          position: mappedStatus === TASK_STATUSES.RANKED ? r.position : null,
          rankingUrl: mappedStatus === TASK_STATUSES.RANKED ? r.rankingUrl : null,
          checkedResults: r?.checkedResults ?? 0,
          googleDetectedLocation: r?.googleDetectedLocation || locCheck.liveLocation.googleDetectedLocation,
          locationVerificationStatus: r?.googleLocationStatus || locCheck.liveLocation.googleLocationStatus,
          googleLocationSource: r?.googleLocationSource || locCheck.liveLocation.googleLocationSource,
          isLiveVerified: Boolean(r?.isLiveVerified),
          durationMs: r?.durationMs ?? null,
          checkedAt: r?.checkedAt || new Date().toISOString(),
          errorDetails: r?.errorDetails || checkRes?.error || null,
        };

        currentTasks[i] = completedTask;
        const taskSave = await jobStorage.saveTaskResult(completedTask);
        if (!taskSave.ok) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.INTERRUPTED,
            currentKeyword: null,
            lastError: taskSave.error,
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: false, error: taskSave.error, quotaExceeded: taskSave.quotaExceeded, job: currentJob, tasks: currentTasks };
        }

        if (onProgress) onProgress({ job: currentJob, tasks: currentTasks });

        // Stop immediately on CAPTCHA / search block; leave remaining tasks Pending
        if (mappedStatus === TASK_STATUSES.SEARCH_BLOCKED) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.SEARCH_BLOCKED,
            currentKeyword: null,
            lastError: completedTask.errorDetails || "Google Search blocked by CAPTCHA or access restriction.",
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: false, error: currentJob.lastError, job: currentJob, tasks: currentTasks };
        }

        // Stop immediately if location failed mid-keyword
        if (
          mappedStatus === TASK_STATUSES.LOCATION_MISMATCH ||
          mappedStatus === TASK_STATUSES.LOCATION_UNVERIFIED
        ) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.LOCATION_VERIFICATION_FAILED,
            currentKeyword: null,
            lastError: completedTask.errorDetails || "Location verification failed during search.",
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: false, error: currentJob.lastError, job: currentJob, tasks: currentTasks };
        }

        // Handle Stop requested while keyword was running
        if (stopRequested || mappedStatus === TASK_STATUSES.STOPPED) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.STOPPED,
            currentKeyword: null,
            completedAt: new Date().toISOString(),
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: false, job: currentJob, tasks: currentTasks };
        }

        // Handle Pause requested while keyword was running
        if (pauseRequested) {
          currentJob = {
            ...currentJob,
            state: JOB_STATES.PAUSED,
            currentKeyword: null,
            pausedAt: new Date().toISOString(),
          };
          await jobStorage.saveJobMetadata(currentJob);
          return { ok: true, paused: true, job: currentJob, tasks: currentTasks };
        }
      }

      const hasAnyErrors = currentTasks.some((t) => isFailedTaskStatus(t.status));
      currentJob = {
        ...currentJob,
        state: hasAnyErrors ? JOB_STATES.COMPLETED_WITH_ERRORS : JOB_STATES.COMPLETED,
        currentKeyword: null,
        completedAt: new Date().toISOString(),
      };
      await jobStorage.saveJobMetadata(currentJob);
      if (onProgress) onProgress({ job: currentJob, tasks: currentTasks });
      return { ok: true, job: currentJob, tasks: currentTasks };
    } finally {
      activeRunJobId = null;
      pauseRequested = false;
      stopRequested = false;
    }
  }

  return {
    isBusy,
    requestPause,
    requestStop,
    verifyLocationIntegrity,
    processQueue,
  };
}

