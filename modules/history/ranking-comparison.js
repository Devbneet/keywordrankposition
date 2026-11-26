/**
 * Accurate organic ranking movement calculations.
 * Enforces context isolation (client/location/device/depth), distinguishes missing
 * historical data from confirmed Not Found, and never marks failed checks as lost.
 */

import { isFailedTaskStatus, TASK_STATUSES } from "../jobs/job-state.js";

export const MOVEMENT_TYPES = Object.freeze({
  IMPROVED: "Improved",
  DECLINED: "Declined",
  UNCHANGED: "Unchanged",
  NEW_RANKING: "New ranking",
  LOST_RANKING: "Lost ranking",
  NOT_FOUND: "Not found",
  MISSING_HISTORY: "Missing history",
  FAILED_EXCLUDED: "Failed / Skipped",
  INCOMPATIBLE: "Incompatible comparison",
});

export function isValidComparableResult(record) {
  if (!record) return false;
  if (
    record.sourceMode === "manual_html" ||
    record.sourceMode === "mock" ||
    record.isMock
  ) {
    return false;
  }
  if (record.isLiveVerified !== true) return false;
  const st = record.resultStatus || record.status;
  return st === TASK_STATUSES.RANKED || st === TASK_STATUSES.NOT_FOUND;
}

export function calculateRankingMovement(previousRecord, currentRecord) {
  if (!currentRecord) {
    return {
      movementType: MOVEMENT_TYPES.FAILED_EXCLUDED,
      delta: null,
      label: "No current check data",
    };
  }

  const currStatus = currentRecord.resultStatus || currentRecord.status;
  if (
    isFailedTaskStatus(currStatus) ||
    currStatus === TASK_STATUSES.PENDING ||
    currStatus === TASK_STATUSES.RUNNING ||
    currentRecord.sourceMode === "manual_html" ||
    currentRecord.sourceMode === "mock" ||
    currentRecord.isMock ||
    currentRecord.isLiveVerified !== true
  ) {
    const reason =
      currentRecord.sourceMode === "manual_html"
        ? "Manual HTML (excluded)"
        : currentRecord.sourceMode === "mock" || currentRecord.isMock
          ? "Mock / Fixture (excluded)"
          : !isFailedTaskStatus(currStatus) &&
              currStatus !== TASK_STATUSES.PENDING &&
              currStatus !== TASK_STATUSES.RUNNING &&
              currentRecord.isLiveVerified !== true
            ? "Unverified result (excluded)"
            : `${currStatus} (not lost)`;
    return {
      movementType: MOVEMENT_TYPES.FAILED_EXCLUDED,
      delta: null,
      label: reason,
    };
  }

  if (!previousRecord || !isValidComparableResult(previousRecord)) {
    return {
      movementType: MOVEMENT_TYPES.MISSING_HISTORY,
      delta: null,
      label: "No prior baseline",
    };
  }

  // Never compare incompatible clients, locations, devices, or incompatible smaller-depth baselines
  if (previousRecord.clientId && currentRecord.clientId && previousRecord.clientId !== currentRecord.clientId) {
    return {
      movementType: MOVEMENT_TYPES.INCOMPATIBLE,
      delta: null,
      label: "Client mismatch",
    };
  }
  if (
    previousRecord.locationId &&
    currentRecord.locationId &&
    previousRecord.locationId !== currentRecord.locationId
  ) {
    return {
      movementType: MOVEMENT_TYPES.INCOMPATIBLE,
      delta: null,
      label: "Location mismatch",
    };
  }
  if (
    previousRecord.deviceType &&
    currentRecord.deviceType &&
    previousRecord.deviceType !== currentRecord.deviceType
  ) {
    return {
      movementType: MOVEMENT_TYPES.INCOMPATIBLE,
      delta: null,
      label: "Device mismatch",
    };
  }
  if (
    previousRecord.requestedDepth &&
    currentRecord.requestedDepth &&
    Number(previousRecord.requestedDepth) !== Number(currentRecord.requestedDepth)
  ) {
    return {
      movementType: MOVEMENT_TYPES.INCOMPATIBLE,
      delta: null,
      label: `Depth mismatch (${previousRecord.requestedDepth} vs ${currentRecord.requestedDepth})`,
    };
  }

  const prevStatus = previousRecord.resultStatus || previousRecord.status;
  const prevPos =
    typeof previousRecord.rankingPosition === "number" ? previousRecord.rankingPosition : previousRecord.position;
  const currPos =
    typeof currentRecord.rankingPosition === "number" ? currentRecord.rankingPosition : currentRecord.position;

  if (prevStatus === TASK_STATUSES.RANKED && currStatus === TASK_STATUSES.RANKED && prevPos > 0 && currPos > 0) {
    const delta = prevPos - currPos;
    if (delta > 0) {
      return { movementType: MOVEMENT_TYPES.IMPROVED, delta, label: `Improved by ${delta}` };
    }
    if (delta < 0) {
      return { movementType: MOVEMENT_TYPES.DECLINED, delta, label: `Declined by ${Math.abs(delta)}` };
    }
    return { movementType: MOVEMENT_TYPES.UNCHANGED, delta: 0, label: "Unchanged" };
  }

  if (prevStatus === TASK_STATUSES.NOT_FOUND && currStatus === TASK_STATUSES.RANKED && currPos > 0) {
    return { movementType: MOVEMENT_TYPES.NEW_RANKING, delta: null, label: `New ranking (#${currPos})` };
  }

  if (prevStatus === TASK_STATUSES.RANKED && currStatus === TASK_STATUSES.NOT_FOUND) {
    return { movementType: MOVEMENT_TYPES.LOST_RANKING, delta: null, label: `Lost ranking (was #${prevPos})` };
  }

  return { movementType: MOVEMENT_TYPES.NOT_FOUND, delta: null, label: "Remained not found" };
}

