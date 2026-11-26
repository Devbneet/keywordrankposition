/**
 * Orchestrates strictly read-only Google Sheets metadata discovery, worksheet
 * verification, structure detection, preview generation, and sync diffing.
 */

import { buildImportedKeywords, buildSpreadsheetPreview } from "./keyword-importer.js";
import { createSheetSnapshot } from "./sheet-snapshot.js";
import { detectSheetStructure } from "./sheet-structure-detector.js";
import { computeSheetSyncDiff } from "./sheet-sync.js";
import { parseGoogleSheetUrl, normalizeWorksheetId, resolveTargetWorksheet } from "./spreadsheet-validator.js";

export function createSheetReader({ sheetsApiClient, clientStorage = null } = {}) {
  if (!sheetsApiClient) {
    throw new Error("sheetsApiClient is required for createSheetReader.");
  }

  async function listWorksheets({ sheetUrlOrId }) {
    const parsed = parseGoogleSheetUrl(sheetUrlOrId);
    if (!parsed.valid) {
      return { ok: false, error: parsed.error };
    }

    const metaRes = await sheetsApiClient.getSpreadsheetMetadata(parsed.spreadsheetId);
    if (!metaRes.ok) {
      return metaRes;
    }

    const sheets = metaRes.data?.sheets || [];
    const worksheets = sheets.map((s) => ({
      sheetId: normalizeWorksheetId(s.properties?.sheetId),
      title: String(s.properties?.title || ""),
      index: s.properties?.index ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    }));

    return {
      ok: true,
      spreadsheetId: parsed.spreadsheetId,
      spreadsheetTitle: metaRes.data?.properties?.title || "",
      locale: metaRes.data?.properties?.locale || "",
      timeZone: metaRes.data?.properties?.timeZone || "",
      urlGid: parsed.gid,
      worksheets,
    };
  }

  async function readAndAnalyzeSheet({
    clientId,
    locationId = null,
    sheetUrlOrId,
    worksheetId = "",
    worksheetName = "",
    columnConfig = {},
    excludedRowNumbers = [],
  }) {
    if (!clientId) {
      return { ok: false, error: "Select a client before reading a Google Sheet." };
    }

    const parsed = parseGoogleSheetUrl(sheetUrlOrId);
    if (!parsed.valid) {
      return { ok: false, error: parsed.error };
    }

    const effectiveWorksheetId = normalizeWorksheetId(worksheetId) || normalizeWorksheetId(parsed.gid);
    const metaRes = await sheetsApiClient.getSpreadsheetMetadata(parsed.spreadsheetId);
    if (!metaRes.ok) {
      return metaRes;
    }

    const wsCheck = resolveTargetWorksheet(metaRes.data?.sheets || [], {
      worksheetId: effectiveWorksheetId,
      worksheetName,
    });
    if (!wsCheck.ok) {
      return {
        ok: false,
        error: wsCheck.error,
        requiresSelection: Boolean(wsCheck.requiresSelection),
        availableWorksheets: wsCheck.availableWorksheets,
      };
    }

    const targetWs = wsCheck.worksheet;
    const escapedTitle = `'${targetWs.title.replace(/'/g, "''")}'`;

    const [gridRes, displayValuesRes, formulaValuesRes] = await Promise.all([
      sheetsApiClient.getSpreadsheetGridDetails(parsed.spreadsheetId, [escapedTitle]),
      sheetsApiClient.batchGetValues(parsed.spreadsheetId, [escapedTitle], {
        valueRenderOption: "FORMATTED_VALUE",
      }),
      sheetsApiClient.batchGetValues(parsed.spreadsheetId, [escapedTitle], {
        valueRenderOption: "FORMULA",
      }),
    ]);

    if (!displayValuesRes.ok) return displayValuesRes;
    if (!formulaValuesRes.ok) return formulaValuesRes;

    const displayRows = displayValuesRes.data?.valueRanges?.[0]?.values || [];
    const formulaRows = formulaValuesRes.data?.valueRanges?.[0]?.values || [];

    const gridSheet =
      gridRes?.ok && Array.isArray(gridRes.data?.sheets)
        ? gridRes.data.sheets.find((s) => normalizeWorksheetId(s.properties?.sheetId) === targetWs.sheetId) || null
        : null;

    const structure = detectSheetStructure({
      spreadsheetId: parsed.spreadsheetId,
      spreadsheetTitle: metaRes.data?.properties?.title || "",
      worksheetId: targetWs.sheetId,
      worksheetName: targetWs.title,
      locale: metaRes.data?.properties?.locale || "",
      timeZone: metaRes.data?.properties?.timeZone || "",
      displayRows,
      formulaRows,
      merges: gridSheet?.merges || targetWs.raw?.merges || [],
      protectedRanges: gridSheet?.protectedRanges || targetWs.raw?.protectedRanges || [],
      hasFilter: Boolean(
        gridSheet?.basicFilter ||
          targetWs.raw?.basicFilter ||
          (gridSheet?.filterViews || targetWs.raw?.filterViews || []).length > 0
      ),
      basicFilter: gridSheet?.basicFilter || targetWs.raw?.basicFilter || null,
      filterViewsCount: (gridSheet?.filterViews || targetWs.raw?.filterViews || []).length,
      conditionalFormats: gridSheet?.conditionalFormats || targetWs.raw?.conditionalFormats || [],
      gridSheet,
      columnConfig,
    });

    const existingKeywords = clientStorage ? await clientStorage.listKeywordsByClient(clientId) : [];
    const existingSnapshots = clientStorage ? await clientStorage.listSheetSnapshotsByClient(clientId) : [];
    const prevSnap = existingSnapshots.find(
      (s) => s.spreadsheetId === parsed.spreadsheetId && normalizeWorksheetId(s.worksheetId) === targetWs.sheetId
    ) || null;

    const importedKeywords = buildImportedKeywords({
      clientId,
      locationId,
      structure,
      excludedRowNumbers,
      existingKeywords,
    });

    const preview = buildSpreadsheetPreview({ structure, importedRecords: importedKeywords });
    const snapshot = createSheetSnapshot({ clientId, locationId, structure });
    const syncDiff = computeSheetSyncDiff({
      previousSnapshot: prevSnap,
      savedKeywords: existingKeywords,
      incomingKeywords: importedKeywords,
      currentStructure: structure,
    });

    return {
      ok: true,
      spreadsheetId: parsed.spreadsheetId,
      worksheet: { sheetId: targetWs.sheetId, title: targetWs.title },
      availableWorksheets: wsCheck.availableWorksheets,
      displayRows,
      formulaRows,
      structure,
      preview,
      importedKeywords,
      snapshot,
      syncDiff,
    };
  }

  return {
    listWorksheets,
    readAndAnalyzeSheet,
  };
}

