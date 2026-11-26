/**
 * Converts detected spreadsheet structure rows into client-isolated imported
 * keyword records, read-only UI preview summaries, and Bulk Checker queues
 * preserving original spreadsheet row positions and duplicate keywords.
 */

export function buildImportedKeywords({
  clientId,
  locationId = null,
  structure,
  excludedRowNumbers = [],
  existingKeywords = [],
} = {}) {
  if (!clientId) {
    throw new Error("clientId is required to import spreadsheet keywords.");
  }
  const excludedSet = new Set(excludedRowNumbers.map((n) => Number(n)));
  const now = new Date().toISOString();

  // Preserve previous user exclusions on exact (spreadsheetId, worksheetId, rowNumber, keyword) match if re-reading
  const priorExcluded = new Set(
    existingKeywords
      .filter((k) => k.excluded || k.active === false)
      .map((k) => `${k.spreadsheetId || ""}::${k.worksheetId || ""}::${k.rowNumber || k.rowPosition}::${k.keyword}`)
  );

  return (structure.keywordRows || []).map((row, index) => {
    const rowNum = Number(row.rowNumber);
    const idScope = `${structure.spreadsheetId}_${structure.worksheetId || "ws"}`;
    const keywordId = `gs_${clientId}_${idScope}_r${rowNum}`;
    const isExcluded =
      excludedSet.has(rowNum) ||
      priorExcluded.has(`${structure.spreadsheetId}::${structure.worksheetId}::${rowNum}::${row.keyword}`);

    return {
      keywordId,
      clientId,
      locationId,
      source: "google_sheets",
      spreadsheetId: structure.spreadsheetId,
      spreadsheetTitle: structure.spreadsheetTitle || "",
      worksheetId: String(structure.worksheetId || ""),
      worksheetName: structure.worksheetName || "",
      rowNumber: rowNum,
      rowPosition: rowNum,
      keyword: row.keyword,
      searchVolume: row.searchVolume || "",
      competition: row.competition || "",
      landingPage: row.landingPage || "",
      serpUrl: row.serpUrl || "",
      existingRankingUrl: row.serpUrl || "",
      latestRank: row.latestRank || "",
      latestRankingDate: row.latestRankingDate || structure.latestDateHeader || "",
      keywordGroup: row.keywordGroup || "Default Group",
      historicalRankings: { ...(row.historicalRankings || {}) },
      hasFormula: Boolean(row.hasFormula),
      merged: Boolean(row.merged),
      excluded: isExcluded,
      active: !isExcluded,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function buildSpreadsheetPreview({ structure, importedRecords = [] } = {}) {
  const excludedCount = importedRecords.filter((r) => r.excluded || r.active === false).length;
  return {
    spreadsheetId: structure.spreadsheetId,
    spreadsheetTitle: structure.spreadsheetTitle || "",
    worksheetId: structure.worksheetId || "",
    worksheetName: structure.worksheetName || "",
    locale: structure.locale || "",
    timeZone: structure.timeZone || "",
    detectedGroups: [...new Set(importedRecords.map((r) => r.keywordGroup).filter(Boolean))],
    totalKeywordRows: importedRecords.length,
    includedKeywordCount: importedRecords.length - excludedCount,
    excludedKeywordCount: excludedCount,
    headerRows: [...(structure.headerRowNumbers || [])],
    separatorRows: [...(structure.blankSeparatorRowNumbers || [])],
    websiteStatsRows: structure.websiteStatsRows || [],
    latestRankingDate: structure.latestDateHeader || "",
    historicalColumns: structure.historicalDateColumns || [],
    mergedRangeCount: (structure.mergedRanges || []).length,
    formulaCellCount: (structure.formulaCells || []).length,
    skippedRows: structure.skippedRows || [],
    isAmbiguous: Boolean(structure.isAmbiguous),
    warnings: structure.warnings || [],
    previewRows: importedRecords.map((r) => ({
      keywordId: r.keywordId,
      rowNumber: r.rowNumber,
      keyword: r.keyword,
      searchVolume: r.searchVolume,
      competition: r.competition,
      landingPage: r.landingPage,
      serpUrl: r.serpUrl,
      latestRank: r.latestRank,
      keywordGroup: r.keywordGroup,
      excluded: Boolean(r.excluded),
    })),
  };
}

export function buildBulkQueueFromImported(importedRecords = []) {
  return importedRecords
    .filter((r) => !r.excluded && r.active !== false)
    .map((r) => ({
      keyword: r.keyword,
      keywordId: r.keywordId,
      keywordGroup: r.keywordGroup,
      rowPosition: r.rowNumber ?? r.rowPosition,
      rowNumber: r.rowNumber ?? r.rowPosition,
      spreadsheetId: r.spreadsheetId || null,
      worksheetId: r.worksheetId || null,
      worksheetName: r.worksheetName || null,
      landingPage: r.landingPage || "",
      searchVolume: r.searchVolume || "",
      competition: r.competition || "",
    }));
}

