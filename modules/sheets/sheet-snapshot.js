/**
 * Structure snapshot & fingerprint generator for read-only safety validation.
 * Phase 9 will compare against this snapshot to verify rows/columns have not
 * shifted unexpectedly before performing any live sheet updates.
 */

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

export function createSheetSnapshot({
  clientId,
  locationId = null,
  structure,
  importedAt = new Date().toISOString(),
}) {
  const canonicalPayload = {
    spreadsheetId: structure.spreadsheetId,
    worksheetId: String(structure.worksheetId || ""),
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
  };

  const structureFingerprint = computeStableHexHash(JSON.stringify(canonicalPayload));

  return {
    snapshotKey: `${clientId}::${structure.spreadsheetId}::${structure.worksheetId || structure.worksheetName}`,
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
 * Check whether an imported spreadsheet's structure has drifted since the snapshot
 * was captured (row shifts, keyword edits, moved headers, or column shifts).
 */
export function compareSnapshotWithStructure(previousSnapshot, currentStructure) {
  if (!previousSnapshot) {
    return { safeToUpdate: false, issues: ["No baseline spreadsheet structure snapshot recorded."] };
  }

  const issues = [];
  if (previousSnapshot.spreadsheetId !== currentStructure.spreadsheetId) {
    issues.push("Spreadsheet ID changed.");
  }
  if (String(previousSnapshot.worksheetId || "") !== String(currentStructure.worksheetId || "")) {
    issues.push("Worksheet ID changed.");
  }

  if (
    JSON.stringify(previousSnapshot.headerRowPositions || []) !==
    JSON.stringify(currentStructure.headerRowNumbers || [])
  ) {
    issues.push("Keyword table header row positions changed in the sheet.");
  }

  if (
    JSON.stringify(previousSnapshot.columnMappings || {}) !==
    JSON.stringify(currentStructure.columnMappings || {})
  ) {
    issues.push("Spreadsheet column mappings changed.");
  }

  const currentMap = new Map(
    (currentStructure.keywordRows || []).map((r) => [r.rowNumber, r.keyword])
  );
  for (const prevRow of previousSnapshot.keywordRows || []) {
    const liveKw = currentMap.get(prevRow.rowNumber);
    if (liveKw === undefined) {
      issues.push(`Expected keyword '${prevRow.keyword}' missing at row ${prevRow.rowNumber}.`);
    } else if (liveKw !== prevRow.keyword) {
      issues.push(
        `Row ${prevRow.rowNumber} keyword changed from '${prevRow.keyword}' to '${liveKw}'.`
      );
    }
  }

  return {
    safeToUpdate: issues.length === 0,
    issues,
  };
}

