/**
 * Interrupted job detection and safe recovery after MV3 service worker restart or browser close.
 */

import { isActiveJobState, JOB_STATES, TASK_STATUSES } from "./job-state.js";

/**
 * Inspect persisted active job on startup/reload. If the previous session died
 * while Running or Validating, mark the job 'Recovery required' and reset any
 * mid-flight Running task back to Pending without discarding completed tasks.
 */
export async function recoverInterruptedJob({ jobStorage }) {
  const job = await jobStorage.loadActiveJob();
  if (!job) {
    return { recovered: false, job: null, tasks: [] };
  }

  const tasks = await jobStorage.loadTasksForJob(job.jobId);
  if (!isActiveJobState(job.state)) {
    return { recovered: false, job, tasks };
  }

  let resetMidFlight = false;
  const updatedTasks = [];
  for (const task of tasks) {
    if (task.status === TASK_STATUSES.RUNNING) {
      const resetTask = {
        ...task,
        status: TASK_STATUSES.PENDING,
        errorDetails: "Previous session ended before this keyword completed.",
      };
      const saveTaskRes = await jobStorage.saveTaskResult(resetTask);
      if (!saveTaskRes.ok) {
        return { recovered: false, error: saveTaskRes.error, job, tasks };
      }
      updatedTasks.push(resetTask);
      resetMidFlight = true;
    } else {
      updatedTasks.push(task);
    }
  }

  const recoveredJob = {
    ...job,
    state: JOB_STATES.RECOVERY_REQUIRED,
    currentKeyword: null,
    interruptedAt: new Date().toISOString(),
    interruptionReason: resetMidFlight
      ? "Service worker or browser closed while checking a keyword. Re-verify location and click Resume."
      : "Session interrupted before job completion. Re-verify location and click Resume.",
  };

  const saveJobRes = await jobStorage.saveJobMetadata(recoveredJob);
  if (!saveJobRes.ok) {
    return { recovered: false, error: saveJobRes.error, job, tasks: updatedTasks };
  }
  return { recovered: true, job: recoveredJob, tasks: updatedTasks };
}

