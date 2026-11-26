/**
 * Validates Google Sheet URLs, extracts spreadsheet IDs and worksheet gids,
 * and strictly verifies the intended worksheet against Google Sheets API metadata.
 */

export function normalizeWorksheetId(value) {
  if (value === 0) return "0";
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function parseGoogleSheetUrl(urlOrId) {
  const raw = String(urlOrId || "").trim();
  if (!raw) {
    return { valid: false, spreadsheetId: "", gid: "", error: "Google Sheet URL or Spreadsheet ID is required." };
  }

  const idMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(raw);
  if (idMatch) {
    const gidMatch = /[?#&]gid=(\d+)/.exec(raw);
    return {
      valid: true,
      spreadsheetId: idMatch[1],
      gid: gidMatch ? gidMatch[1] : "",
      error: null,
    };
  }

  if (/^[a-zA-Z0-9-_]{15,}$/.test(raw)) {
    return { valid: true, spreadsheetId: raw, gid: "", error: null };
  }

  return {
    valid: false,
    spreadsheetId: "",
    gid: "",
    error: "Invalid Google Sheet URL or Spreadsheet ID.",
  };
}

/**
 * Strictly match target worksheet by ID (gid) or exact normalized name.
 * NEVER silently falls back to the first worksheet when an explicit target fails to match.
 */
export function resolveTargetWorksheet(sheets = [], { worksheetId = "", worksheetName = "" } = {}) {
  const normalizedList = sheets.map((s) => ({
    sheetId: normalizeWorksheetId(s.properties?.sheetId),
    title: String(s.properties?.title || ""),
    index: s.properties?.index ?? 0,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    raw: s,
  }));

  if (normalizedList.length === 0) {
    return { ok: false, error: "Spreadsheet contains no worksheets.", availableWorksheets: [] };
  }

  const cleanId = normalizeWorksheetId(worksheetId);
  const cleanName = String(worksheetName || "").trim();

  if (cleanId) {
    const byId = normalizedList.find((w) => w.sheetId === cleanId);
    if (!byId) {
      return {
        ok: false,
        error: `Requested worksheet ID (gid=${cleanId}) was not found in this spreadsheet.`,
        availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })),
      };
    }
    if (cleanName && byId.title.trim().toLowerCase() !== cleanName.toLowerCase()) {
      return {
        ok: false,
        error: `Worksheet ID '${cleanId}' resolves to '${byId.title}', which does not match expected worksheet name '${cleanName}'.`,
        availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })),
      };
    }
    return { ok: true, worksheet: byId, availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })) };
  }

  if (cleanName) {
    const byName = normalizedList.find((w) => w.title.trim().toLowerCase() === cleanName.toLowerCase());
    if (!byName) {
      return {
        ok: false,
        error: `Worksheet '${cleanName}' was not found. Available worksheets: ${normalizedList.map((w) => w.title).join(", ")}.`,
        availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })),
      };
    }
    return { ok: true, worksheet: byName, availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })) };
  }

  if (normalizedList.length === 1) {
    return { ok: true, worksheet: normalizedList[0], availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })) };
  }

  return {
    ok: false,
    requiresSelection: true,
    error: "Multiple worksheets found. Explicitly select the target worksheet name or gid.",
    availableWorksheets: normalizedList.map(({ sheetId, title }) => ({ sheetId, title })),
  };
}

