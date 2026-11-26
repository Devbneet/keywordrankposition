/**
 * Read-only keyword synchronization diff engine & confirmed local update handler.
 * Detects additions, removals, edits, row moves, landing page changes, and
 * structural changes without ever overwriting saved keywords silently or modifying
 * Google Sheets or historical ranking results.
 */

import { compareSnapshotWithStructure } from "./sheet-snapshot.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

export function computeSheetSyncDiff({
  previousSnapshot = null,
  savedKeywords = [],
  incomingKeywords = [],
  currentStructure,
}) {
  const spreadsheetId = currentStructure.spreadsheetId;
  const worksheetId = normalizeWorksheetId(currentStructure.worksheetId);

  const scopedSaved = savedKeywords.filter(
    (k) =>
      k.source === "google_sheets" &&
      k.spreadsheetId === spreadsheetId &&
      normalizeWorksheetId(k.worksheetId) === worksheetId
  );

  const savedByRow = new Map(scopedSaved.map((k) => [Number(k.rowNumber || k.rowPosition), k]));
  const incomingByRow = new Map(incomingKeywords.map((k) => [Number(k.rowNumber || k.rowPosition), k]));

  const matchedSavedIds = new Set();
  const matchedIncomingRows = new Set();

  const unchanged = [];
  const editedKeywords = [];
  const changedLandingPages = [];
  const movedRows = [];
  const added = [];
  const removed = [];

  // Pass 1: exact same row number
  for (const [rowNum, inc] of incomingByRow.entries()) {
    const prev = savedByRow.get(rowNum);
    if (!prev) continue;

    matchedSavedIds.add(prev.keywordId);
    matchedIncomingRows.add(rowNum);

    if (prev.keyword === inc.keyword && (prev.landingPage || "") === (inc.landingPage || "")) {
      unchanged.push({ rowNumber: rowNum, keyword: inc.keyword });
    } else if (prev.keyword !== inc.keyword) {
      editedKeywords.push({
        rowNumber: rowNum,
        previousKeyword: prev.keyword,
        newKeyword: inc.keyword,
      });
    } else {
      changedLandingPages.push({
        rowNumber: rowNum,
        keyword: inc.keyword,
        previousLandingPage: prev.landingPage || "",
        newLandingPage: inc.landingPage || "",
      });
    }
  }

  // Pass 2: match unmatched saved keywords against unmatched incoming rows for moved rows (exact keyword + landingPage first, then keyword)
  const remainingSaved = scopedSaved.filter((k) => !matchedSavedIds.has(k.keywordId));
  const remainingIncoming = incomingKeywords.filter((k) => !matchedIncomingRows.has(k.rowNumber));

  const consumedIncoming = new Set();
  for (const prev of remainingSaved) {
    const matchIdx = remainingIncoming.findIndex(
      (inc, idx) =>
        !consumedIncoming.has(idx) &&
        inc.keyword === prev.keyword &&
        (inc.landingPage || "") === (prev.landingPage || "")
    );
    const fallbackIdx =
      matchIdx !== -1
        ? matchIdx
        : remainingIncoming.findIndex((inc, idx) => !consumedIncoming.has(idx) && inc.keyword === prev.keyword);

    if (fallbackIdx !== -1) {
      consumedIncoming.add(fallbackIdx);
      const inc = remainingIncoming[fallbackIdx];
      movedRows.push({
        keyword: inc.keyword,
        previousRow: Number(prev.rowNumber || prev.rowPosition),
        newRow: inc.rowNumber,
      });
      if ((prev.landingPage || "") !== (inc.landingPage || "")) {
        changedLandingPages.push({
          rowNumber: inc.rowNumber,
          keyword: inc.keyword,
          previousLandingPage: prev.landingPage || "",
          newLandingPage: inc.landingPage || "",
        });
      }
    } else {
      removed.push({
        rowNumber: Number(prev.rowNumber || prev.rowPosition),
        keyword: prev.keyword,
        keywordId: prev.keywordId,
      });
    }
  }

  remainingIncoming.forEach((inc, idx) => {
    if (!consumedIncoming.has(idx)) {
      added.push({
        rowNumber: inc.rowNumber,
        keyword: inc.keyword,
        keywordGroup: inc.keywordGroup,
      });
    }
  });

  const snapshotComparison = previousSnapshot
    ? compareSnapshotWithStructure(previousSnapshot, currentStructure)
    : { safeToUpdate: true, issues: [] };
  const structureChanged = previousSnapshot ? !snapshotComparison.safeToUpdate : false;

  const hasChanges =
    added.length > 0 ||
    removed.length > 0 ||
    editedKeywords.length > 0 ||
    movedRows.length > 0 ||
    changedLandingPages.length > 0 ||
    structureChanged;

  return {
    isInitialImport: scopedSaved.length === 0 && !previousSnapshot,
    hasChanges,
    requiresConfirmation: true,
    structureChanged,
    structureIssues: snapshotComparison.issues,
    added,
    removed,
    editedKeywords,
    movedRows,
    changedLandingPages,
    unchangedCount: unchanged.length,
  };
}

/**
 * Commit synced Google Sheet keywords to local client storage ONLY when user confirms.
 * Preserves historical ranking results and unrelated client/manual keywords.
 */
export async function applyConfirmedSheetSync({
  clientStorage,
  clientId,
  incomingKeywords = [],
  snapshot,
  confirmed = false,
} = {}) {
  if (!confirmed) {
    return {
      ok: false,
      requiresConfirmation: true,
      error: "Explicit user confirmation is required before applying Google Sheet keyword changes locally.",
    };
  }
  if (!clientId || !snapshot) {
    return { ok: false, error: "clientId and snapshot are required to save synced keywords." };
  }

  const wsId = normalizeWorksheetId(snapshot.worksheetId);
  const allClientKeywords = await clientStorage.listKeywordsByClient(clientId);
  const previousForSheet = allClientKeywords.filter(
    (k) =>
      k.source === "google_sheets" &&
      k.spreadsheetId === snapshot.spreadsheetId &&
      normalizeWorksheetId(k.worksheetId) === wsId
  );

  for (const oldKw of previousForSheet) {
    const delRes = await clientStorage.deleteKeyword(oldKw.keywordId);
    if (!delRes.ok) return delRes;
  }

  if (incomingKeywords.length > 0) {
    const saveRes = await clientStorage.saveKeywordsBulk(incomingKeywords);
    if (!saveRes.ok) return saveRes;
  }

  const snapRes = await clientStorage.saveSheetSnapshot(snapshot);
  if (!snapRes.ok) return snapRes;

  return {
    ok: true,
    savedCount: incomingKeywords.length,
    snapshot,
  };
}

