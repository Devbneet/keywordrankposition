/**
 * Validates ranking jobs, tasks, live-verification eligibility, row identity,
 * same-date overwrite rules, and cross-client/location sheet safety before planning writes.
 */

import { TASK_STATUSES } from "../jobs/job-state.js";
import { isTargetDomainMatch } from "../ranking/domain-matcher.js";
import { validateCrossClientSheetConfigurations, validateLocationWorksheetIsolation } from "./sheet-range-validator.js";
import { compareSnapshotWithStructure } from "./sheet-snapshot.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

function isValidHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isTaskEligibleForLiveSheetWrite(task) {
  if (!task) return { eligible: false, reason: "Missing task record." };
  if (
    task.source === "manual_html" ||
    task.sourceMode === "manual_html" ||
    task.useManualHtml
  ) {
    return { eligible: false, reason: "Manual HTML test results cannot be written to live client sheets." };
  }
  if (task.source === "mock" || task.sourceMode === "mock" || task.isMock || task.isAccuracyFixture) {
    return { eligible: false, reason: "Mock or Accuracy Lab fixture results cannot be written to live client sheets." };
  }
  return { eligible: true };
}

export function evaluateTaskUpdatePolicy({
  task,
  liveRow,
  existingSameDateValue = "",
  isReusingSameDateColumn = false,
}) {
  const elig = isTaskEligibleForLiveSheetWrite(task);
  if (!elig.eligible) {
    return { action: "REJECTED_SOURCE", writeRank: false, writeSerp: false, reason: elig.reason };
  }

  const hasExistingValidRank =
    isReusingSameDateColumn &&
    existingSameDateValue !== "" &&
    existingSameDateValue !== null &&
    existingSameDateValue !== undefined;

  if (task.status === TASK_STATUSES.RANKED) {
    if (
      task.isLiveVerified !== true ||
      !Number.isInteger(task.position) ||
      task.position < 1 ||
      !task.rankingUrl ||
      !isValidHttpUrl(task.rankingUrl)
    ) {
      return {
        action: "SKIP_FAILED",
        writeRank: false,
        writeSerp: false,
        reason: "Ranked task missing live verification flag, positive integer position, or valid HTTP/HTTPS ranking URL.",
      };
    }
    const expectedDomain = task.targetDomain || task.clientDomain || "";
    if (expectedDomain && !isTargetDomainMatch({ resultUrl: task.rankingUrl, targetDomain: expectedDomain })) {
      return {
        action: "SKIP_FAILED",
        writeRank: false,
        writeSerp: false,
        reason: `Ranking URL '${task.rankingUrl}' does not match target domain '${expectedDomain}'.`,
      };
    }
    return {
      action: "UPDATE_RANK_AND_SERP",
      writeRank: true,
      newRank: Number(task.position),
      writeSerp: true,
      newSerpUrl: String(task.rankingUrl),
      reason: "Confirmed live organic ranking",
    };
  }

  if (task.status === TASK_STATUSES.NOT_FOUND) {
    const requestedDepth = Number(task.requestedDepth) || 50;
    const checked = Number(task.actualVerifiedDepth ?? task.checkedResults ?? 0);
    const hasEndEvidence = Boolean(task.verifiedEndOfResults ?? task.endOfResultsVerified);
    const depthConfirmed = task.isLiveVerified === true && (checked >= requestedDepth || hasEndEvidence);
    if (!depthConfirmed) {
      return {
        action: "SKIP_FAILED",
        writeRank: false,
        writeSerp: false,
        reason: "Not found result lacks full verified search depth confirmation.",
      };
    }
    return {
      action: "WRITE_NA",
      writeRank: true,
      newRank: "NA",
      writeSerp: false,
      reason: "Confirmed NA across verified depth (previous SERP preserved)",
    };
  }

  // Failed / CAPTCHA / Blocked / Incomplete / Unverified / Stopped / Pending:
  // NEVER write NA and NEVER overwrite an existing valid rank from the same date.
  const reason = hasExistingValidRank
    ? `Skipped failed task ('${task.status}') — existing same-date rank '${existingSameDateValue}' preserved`
    : `Skipped non-verified/failed task ('${task.status}') — cell left blank`;

  return {
    action: "SKIP_FAILED",
    writeRank: false,
    writeSerp: false,
    reason,
  };
}

export function validatePrePlanSafety({
  client,
  allClients = [],
  locationsByClient = {},
  location,
  job,
  tasks = [],
  baselineSnapshot = null,
  liveStructure,
  datePlan,
} = {}) {
  const errors = [];
  const warnings = [];

  if (!client || !job) {
    return { valid: false, errors: ["Client and ranking job are required."], warnings: [], taskDecisions: [] };
  }

  if (job.clientId && job.clientId !== client.clientId) {
    errors.push(`Job client '${job.clientId}' does not match selected client '${client.clientId}'.`);
  }

  if (location && job.locationId && job.locationId !== location.locationId) {
    errors.push(`Job location '${job.locationId}' does not match selected location '${location.locationId}'.`);
  }

  // Enforce location & cross-client isolation
  const clientLocs = locationsByClient[client.clientId] || (location ? [location] : []);
  const locIso = validateLocationWorksheetIsolation({
    sheetConfig: client.sheetConfig,
    locations: clientLocs,
  });
  if (!locIso.valid) {
    errors.push(...locIso.collisions);
  }

  const crossIso = validateCrossClientSheetConfigurations({
    clients: allClients,
    locationsByClient,
  });
  if (!crossIso.valid) {
    errors.push(...crossIso.collisions);
  }

  // Snapshot drift verification against baseline import
  if (baselineSnapshot) {
    const snapCheck = compareSnapshotWithStructure(baselineSnapshot, liveStructure);
    if (!snapCheck.safeToUpdate) {
      errors.push(...snapCheck.issues);
    }
  } else {
    warnings.push("No prior import snapshot found; validating rows directly against live sheet.");
  }

  // Match every eligible task strictly by rowNumber + keyword + spreadsheet/worksheet identity
  const liveByRow = new Map((liveStructure.keywordRows || []).map((r) => [Number(r.rowNumber), r]));
  const liveWsId = normalizeWorksheetId(liveStructure.worksheetId);
  const taskDecisions = [];

  for (const task of tasks) {
    if (task.spreadsheetId && task.spreadsheetId !== liveStructure.spreadsheetId) {
      errors.push(`Task row ${task.rowPosition} belongs to spreadsheet '${task.spreadsheetId}', expected '${liveStructure.spreadsheetId}'.`);
      continue;
    }
    const taskWsId = normalizeWorksheetId(task.worksheetId);
    if (taskWsId !== "" && liveWsId !== "" && taskWsId !== liveWsId) {
      errors.push(`Task row ${task.rowPosition} belongs to worksheet '${taskWsId}', expected '${liveWsId}'.`);
      continue;
    }

    const rowNum = Number(task.rowNumber ?? task.rowPosition);
    const liveRow = liveByRow.get(rowNum);
    if (!liveRow) {
      errors.push(`Keyword '${task.keyword}' expected at row ${rowNum} was not found in the current spreadsheet.`);
      continue;
    }
    if (liveRow.keyword !== task.keyword) {
      errors.push(
        `Row identity mismatch at row ${rowNum}: expected keyword '${task.keyword}', found '${liveRow.keyword}'. Re-import Google Sheet first.`
      );
      continue;
    }

    const decision = evaluateTaskUpdatePolicy({
      task,
      liveRow,
      existingSameDateValue: liveRow.latestRank,
      isReusingSameDateColumn: datePlan?.action === "REUSE_EXISTING_COLUMN",
    });

    taskDecisions.push({
      task,
      liveRow,
      ...decision,
    });
  }

  if ((liveStructure.protectedRanges || []).length > 0) {
    warnings.push(
      `Worksheet has ${liveStructure.protectedRanges.length} protected range(s). Protected cells overlapping target columns will fail HTTP 403 if not editable.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    taskDecisions,
  };
}

