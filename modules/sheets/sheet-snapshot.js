/**
 * Structure snapshot & fingerprint generator for read-only and pre-write validation.
 * Compares headers, keyword rows (added/removed/edited/moved), historical date headers,
 * merged ranges, formulas, protected ranges, filters, conditional formatting, and user formatting.
 */

import { normalizeWorksheetId } from "./spreadsheet-validator.js";

function computeStableHexHash(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function serializeProtectedRanges(ranges = []) {
  return ranges.map((p) => ({
    description: p.description || "",
    range: p.range || null,
  }));
}

function buildStructureMetadataForFingerprint(structure) {
  const wsId = normalizeWorksheetId(structure.worksheetId);
  return {
    spreadsheetId: structure.spreadsheetId,
    worksheetId: wsId,
    worksheetName: structure.worksheetName,
    headerRowPositions: [...(structure.headerRowNumbers || [])],
    columnMappings: { ...(structure.columnMappings || {}) },
    latestDateHeader: structure.latestDateHeader || "",
    historicalDateHeaders: (structure.historicalDateColumns || []).map((h) => `${h.columnLetter}:${h.header}`),
    keywordRows: (structure.keywordRows || []).map((k) => ({
      rowNumber: k.rowNumber,
      keyword: k.keyword,
      keywordGroup: k.keywordGroup,
      landingPage: k.landingPage,
    })),
    mergedRanges: (structure.mergedRanges || []).map(
      (m) => `${m.startCol}${m.startRow}:${m.endCol}${m.endRow}`
    ),
    formulaLocations: (structure.formulaCells || []).map((f) => `${f.a1}=${f.formula}`),
    protectedRanges: serializeProtectedRanges(structure.protectedRanges || []),
    filterSummary: structure.filterSummary || { hasBasicFilter: Boolean(structure.hasFilter), filterViewsCount: 0 },
    conditionalFormatsCount: Number(structure.conditionalFormatsCount ?? (structure.conditionalFormats || []).length),
    conditionalFormats: structure.conditionalFormats || [],
    formattingSummary: {
      detectedColors: structure.formattingMetadata?.detectedColors || [],
      columnWidths: structure.formattingMetadata?.columnWidths || [],
      templateHeaderFormat: structure.formattingMetadata?.templateHeaderFormat || null,
      templateDataFormat: structure.formattingMetadata?.templateDataFormat || null,
    },
  };
}

export function createSheetSnapshot({
  clientId,
  locationId = null,
  structure,
  importedAt = new Date().toISOString(),
}) {
  const canonicalPayload = buildStructureMetadataForFingerprint(structure);
  const structureFingerprint = computeStableHexHash(JSON.stringify(canonicalPayload));
  const wsKey = canonicalPayload.worksheetId !== "" ? canonicalPayload.worksheetId : canonicalPayload.worksheetName;

  return {
    snapshotKey: `${clientId}::${structure.spreadsheetId}::${wsKey}`,
    clientId,
    locationId,
    ...canonicalPayload,
    locale: structure.locale || "",
    timeZone: structure.timeZone || "",
    importedAt,
    structureFingerprint,
  };
}

/**
 * Thoroughly compare baseline snapshot with current sheet structure.
 * Detects added/removed/edited/moved keyword rows, header shifts, column shifts,
 * historical date header changes, merged ranges, formulas, protected ranges,
 * filters, conditional formatting, and user-entered formatting changes.
 */
export function compareSnapshotWithStructure(previousSnapshot, currentStructure) {
  if (!previousSnapshot) {
    return {
      safeToUpdate: false,
      issues: ["No baseline spreadsheet structure snapshot recorded."],
      diff: null,
    };
  }

  const currentCanonical = buildStructureMetadataForFingerprint(currentStructure);
  const issues = [];

  if (previousSnapshot.spreadsheetId !== currentCanonical.spreadsheetId) {
    issues.push("Spreadsheet ID changed.");
  }
  if (normalizeWorksheetId(previousSnapshot.worksheetId) !== currentCanonical.worksheetId) {
    issues.push("Worksheet ID changed.");
  }

  if (
    JSON.stringify(previousSnapshot.headerRowPositions || []) !==
    JSON.stringify(currentCanonical.headerRowPositions || [])
  ) {
    issues.push("Keyword table header row positions changed in the sheet.");
  }

  if (
    JSON.stringify(previousSnapshot.columnMappings || {}) !==
    JSON.stringify(currentCanonical.columnMappings || {})
  ) {
    issues.push("Spreadsheet column mappings changed.");
  }

  if (
    JSON.stringify(previousSnapshot.historicalDateHeaders || []) !==
    JSON.stringify(currentCanonical.historicalDateHeaders || [])
  ) {
    issues.push("Historical ranking date headers changed unexpectedly.");
  }

  if (
    JSON.stringify(previousSnapshot.mergedRanges || []) !==
    JSON.stringify(currentCanonical.mergedRanges || [])
  ) {
    issues.push("Merged cell ranges changed since last snapshot.");
  }

  if (
    JSON.stringify(previousSnapshot.formulaLocations || []) !==
    JSON.stringify(currentCanonical.formulaLocations || [])
  ) {
    issues.push("Spreadsheet formula cells changed since last snapshot.");
  }

  if (
    JSON.stringify(previousSnapshot.protectedRanges || []) !==
    JSON.stringify(currentCanonical.protectedRanges || [])
  ) {
    issues.push("Protected ranges configuration changed since last snapshot.");
  }

  if (
    JSON.stringify(previousSnapshot.filterSummary || {}) !==
    JSON.stringify(currentCanonical.filterSummary || {})
  ) {
    issues.push("Spreadsheet filters changed since last snapshot.");
  }

  if (
    Number(previousSnapshot.conditionalFormatsCount ?? 0) !== Number(currentCanonical.conditionalFormatsCount ?? 0) ||
    JSON.stringify(previousSnapshot.conditionalFormats || []) !==
      JSON.stringify(currentCanonical.conditionalFormats || [])
  ) {
    issues.push("Conditional formatting rules changed since last snapshot.");
  }

  if (
    previousSnapshot.formattingSummary &&
    JSON.stringify(previousSnapshot.formattingSummary) !== JSON.stringify(currentCanonical.formattingSummary)
  ) {
    issues.push("Template cell formatting or column widths changed since last snapshot.");
  }

  const prevByRow = new Map((previousSnapshot.keywordRows || []).map((r) => [r.rowNumber, r]));
  const currByRow = new Map((currentCanonical.keywordRows || []).map((r) => [r.rowNumber, r]));

  const addedRows = [];
  const removedRows = [];
  const editedRows = [];
  const movedRows = [];

  for (const [rowNum, prevRow] of prevByRow.entries()) {
    const liveRow = currByRow.get(rowNum);
    if (!liveRow) {
      const movedTo = (currentCanonical.keywordRows || []).find(
        (r) =>
          !prevByRow.has(r.rowNumber) &&
          r.keyword === prevRow.keyword &&
          (r.landingPage || "") === (prevRow.landingPage || "")
      );
      if (movedTo) {
        movedRows.push({
          keyword: prevRow.keyword,
          previousRow: rowNum,
          newRow: movedTo.rowNumber,
        });
        issues.push(`Keyword '${prevRow.keyword}' moved from row ${rowNum} to row ${movedTo.rowNumber}.`);
      } else {
        removedRows.push({ rowNumber: rowNum, keyword: prevRow.keyword });
        issues.push(`Expected keyword '${prevRow.keyword}' missing/removed at row ${rowNum}.`);
      }
    } else if (liveRow.keyword !== prevRow.keyword) {
      editedRows.push({
        rowNumber: rowNum,
        previousKeyword: prevRow.keyword,
        newKeyword: liveRow.keyword,
      });
      issues.push(
        `Row ${rowNum} keyword changed from '${prevRow.keyword}' to '${liveRow.keyword}'.`
      );
    }
  }

  for (const [rowNum, currRow] of currByRow.entries()) {
    if (!prevByRow.has(rowNum) && !movedRows.some((m) => m.newRow === rowNum)) {
      addedRows.push({ rowNumber: rowNum, keyword: currRow.keyword });
      issues.push(`New keyword '${currRow.keyword}' added at row ${rowNum} since last import.`);
    }
  }

  return {
    safeToUpdate: issues.length === 0,
    issues,
    diff: {
      addedRows,
      removedRows,
      editedRows,
      movedRows,
    },
  };
}

