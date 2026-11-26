/**
 * Job and per-keyword task state definitions for bulk ranking automation.
 */

export const JOB_STATES = Object.freeze({
  READY: "Ready",
  VALIDATING: "Validating",
  RUNNING: "Running",
  PAUSED: "Paused",
  STOPPED: "Stopped",
  COMPLETED: "Completed",
  COMPLETED_WITH_ERRORS: "Completed with errors",
  LOCATION_VERIFICATION_FAILED: "Location verification failed",
  SEARCH_BLOCKED: "Search blocked",
  INTERRUPTED: "Interrupted",
  RECOVERY_REQUIRED: "Recovery required",
});

export const TASK_STATUSES = Object.freeze({
  PENDING: "Pending",
  RUNNING: "Running",
  RANKED: "Confirmed ranking",
  NOT_FOUND: "Confirmed not found",
  INCOMPLETE_SEARCH: "Incomplete search",
  LOCATION_MISMATCH: "Location mismatch",
  LOCATION_UNVERIFIED: "Location unverified",
  SEARCH_BLOCKED: "Search blocked",
  NETWORK_ERROR: "Network error",
  PARSING_ERROR: "Parsing error",
  STOPPED: "Stopped",
});

export function isActiveJobState(state) {
  return state === JOB_STATES.VALIDATING || state === JOB_STATES.RUNNING;
}

export function isTerminalJobState(state) {
  return (
    state === JOB_STATES.COMPLETED ||
    state === JOB_STATES.COMPLETED_WITH_ERRORS ||
    state === JOB_STATES.STOPPED
  );
}

export function isFailedTaskStatus(status) {
  return (
    status === TASK_STATUSES.INCOMPLETE_SEARCH ||
    status === TASK_STATUSES.LOCATION_MISMATCH ||
    status === TASK_STATUSES.LOCATION_UNVERIFIED ||
    status === TASK_STATUSES.SEARCH_BLOCKED ||
    status === TASK_STATUSES.NETWORK_ERROR ||
    status === TASK_STATUSES.PARSING_ERROR ||
    status === TASK_STATUSES.STOPPED
  );
}

