/**
 * Builds deterministic, single-atomic Google Sheets Update Plans with canonical
 * planFingerprints and expected post-update shifted column coordinates.
 */

import { planDateColumnOperation } from "./date-column-manager.js";
import { buildAtomicBatchUpdateRequests } from "./sheet-format-manager.js";
import { indexToColumnLetters } from "./sheet-range-validator.js";
import { validatePrePlanSafety } from "./sheet-update-validator.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

function computePlanFingerprint(obj) {
  const str = JSON.stringify(obj);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h1 ^= str.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return `plan_${(h1 >>> 0).toString(16).padStart(8, "0")}_${str.length}`;
}

export function buildSheetUpdatePlan({
  client,
  allClients = [client].filter(Boolean),
  locationsByClient = {},
  location = null,
  job,
  tasks = [],
  liveStructure,
  displayRows = [],
  baselineSnapshot = null,
  reportingDate = new Date(),
  explicitHeaderLabel = "",
} = {}) {
  const datePlan = planDateColumnOperation({
    structure: liveStructure,
    displayRows,
    reportingDate,
    explicitHeaderLabel,
  });

  if (!datePlan.ok) {
    return {
      ok: false,
      status: "STRUCTURE_CHANGED",
      error: datePlan.error,
      errors: [datePlan.error],
    };
  }

  const safety = validatePrePlanSafety({
    client,
    allClients,
    locationsByClient,
    location,
    job,
    tasks,
    baselineSnapshot,
    liveStructure,
    datePlan,
  });

  if (!safety.valid) {
    return {
      ok: false,
      status: "STRUCTURE_CHANGED",
      error: safety.errors[0],
      errors: safety.errors,
      warnings: safety.warnings,
    };
  }

  const rankUpdates = [];
  const serpUpdates = [];
  const beforeAfterRows = [];

  let validRankingUpdates = 0;
  let confirmedNaUpdates = 0;
  let skippedOrFailedCount = 0;

  for (const dec of safety.taskDecisions) {
    const rowNumber = dec.liveRow.rowNumber;
    const prevRank = dec.liveRow.latestRank || "-";
    const prevSerp = dec.liveRow.serpUrl || "-";

    if (dec.writeRank) {
      rankUpdates.push({
        rowNumber,
        keyword: dec.task.keyword,
        taskId: dec.task.taskId,
        newRank: dec.newRank,
      });
      if (dec.action === "UPDATE_RANK_AND_SERP") validRankingUpdates += 1;
      if (dec.action === "WRITE_NA") confirmedNaUpdates += 1;
    } else {
      skippedOrFailedCount += 1;
    }

    if (dec.writeSerp) {
      serpUpdates.push({
        rowNumber,
        keyword: dec.task.keyword,
        taskId: dec.task.taskId,
        newSerpUrl: dec.newSerpUrl,
      });
    }

    beforeAfterRows.push({
      rowNumber,
      keyword: dec.task.keyword,
      keywordGroup: dec.liveRow.keywordGroup || "",
      previousRank: prevRank,
      newRank: dec.writeRank ? String(dec.newRank) : "(Blank — preserved)",
      previousSerpUrl: prevSerp,
      newSerpUrl: dec.writeSerp ? dec.newSerpUrl : `${prevSerp} (Preserved)`,
      updateStatus: dec.reason,
      action: dec.action,
    });
  }

  if (rankUpdates.length === 0 && serpUpdates.length === 0) {
    return {
      ok: false,
      status: "NO_ELIGIBLE_UPDATES",
      error: "No eligible verified ranking or SERP updates to apply; physical column insertion skipped.",
      errors: ["No eligible verified ranking or SERP updates to apply."],
      warnings: safety.warnings,
      beforeAfterRows,
    };
  }

  const worksheetId = normalizeWorksheetId(liveStructure.worksheetId);
  const requests = buildAtomicBatchUpdateRequests({
    worksheetId,
    structure: liveStructure,
    displayRows,
    datePlan,
    rankUpdates,
    serpUpdates,
  });

  const shiftDelta = datePlan.willInsertColumn ? 1 : 0;
  const expectedHistoricalColumns = (liveStructure.historicalDateColumns || []).map((col) => {
    const origIdx = (() => {
      let n = 0;
      for (let i = 0; i < col.columnLetter.length; i += 1) n = n * 26 + (col.columnLetter.charCodeAt(i) - 64);
      return n;
    })();
    return {
      previousColumn: col.columnLetter,
      expectedColumn: indexToColumnLetters(origIdx + shiftDelta),
      header: col.header,
    };
  });

  const planBody = {
    clientId: client.clientId,
    locationId: location?.locationId || null,
    jobId: job.jobId,
    spreadsheetId: liveStructure.spreadsheetId,
    worksheetId,
    worksheetName: liveStructure.worksheetName,
    dateAction: datePlan.action,
    willInsertColumn: datePlan.willInsertColumn,
    targetDateLabel: datePlan.targetDateLabel,
    targetColIndex: datePlan.targetColIndex,
    targetColumnLetter: datePlan.targetColumnLetter,
    rankUpdates,
    serpUpdates,
    headerRowNumbers: liveStructure.headerRowNumbers || [],
    expectedHistoricalColumns,
  };

  const planFingerprint = computePlanFingerprint(planBody);

  return {
    ok: true,
    plan: {
      ...planBody,
      clientName: client.clientName,
      spreadsheetTitle: liveStructure.spreadsheetTitle || "",
      locationName: location?.locationName || "Default",
      existingLatestDate: datePlan.existingLatestDate || "None",
      totalKeywordRows: (liveStructure.keywordRows || []).length,
      validRankingUpdates,
      confirmedNaUpdates,
      skippedOrFailedCount,
      serpUrlsToUpdate: serpUpdates.length,
      dateHeadersToUpdate: datePlan.willInsertColumn ? (liveStructure.headerRowNumbers || []).length : 0,
      beforeAfterRows,
      warnings: safety.warnings,
      requests,
      planFingerprint,
    },
  };
}

