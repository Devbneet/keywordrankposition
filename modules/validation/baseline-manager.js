/**
 * Manage manually verified GS Location Changer baseline rows and CSV import/serialization.
 * Never fabricates manual baseline rankings.
 */

export const VALIDATION_STORAGE_KEY = "dm_accuracy_validation";

export const BASELINE_CSV_COLUMNS = Object.freeze([
  "Keyword",
  "Manual Ranking",
  "Manual Ranking URL",
  "Target Location",
  "Latitude",
  "Longitude",
  "Device",
  "Checked At",
]);

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function normalizeManualRank(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  const cleaned = String(rawValue).trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.toUpperCase() === "NA" || cleaned.toLowerCase() === "not found") {
    return "NA";
  }
  const num = Number(cleaned);
  if (Number.isInteger(num) && num >= 1) {
    return num;
  }
  return null;
}

function parseOptionalNumber(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  const num = Number(String(rawValue).trim());
  return Number.isFinite(num) ? num : null;
}

function normalizeHeaderKey(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Parse GS Location Changer baseline CSV text into structured rows.
 */
export function parseBaselineCsv(csvText) {
  const rawLines = String(csvText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (rawLines.length === 0) {
    return { ok: false, error: "CSV is empty.", rows: [] };
  }

  const headers = parseCsvLine(rawLines[0]);
  const indexMap = new Map();
  headers.forEach((h, idx) => indexMap.set(normalizeHeaderKey(h), idx));

  const kwIdx = indexMap.get("keyword");
  if (kwIdx === undefined) {
    return {
      ok: false,
      error: "CSV must include a 'Keyword' header column.",
      rows: [],
    };
  }

  const getField = (cells, ...keys) => {
    for (const key of keys) {
      const idx = indexMap.get(key);
      if (idx !== undefined && idx < cells.length) {
        return cells[idx];
      }
    }
    return "";
  };

  const rows = [];
  for (let i = 1; i < rawLines.length; i += 1) {
    const cells = parseCsvLine(rawLines[i]);
    const keyword = String(getField(cells, "keyword") || "").trim();
    if (!keyword) continue;

    rows.push({
      rowIndex: rows.length,
      keyword,
      manualRanking: normalizeManualRank(getField(cells, "manualranking", "ranking", "position")),
      manualRankingUrl: String(getField(cells, "manualrankingurl", "rankingurl", "url") || "").trim(),
      targetLocation: String(getField(cells, "targetlocation", "location") || "").trim(),
      latitude: parseOptionalNumber(getField(cells, "latitude", "lat")),
      longitude: parseOptionalNumber(getField(cells, "longitude", "lng", "lon")),
      device: String(getField(cells, "device", "devicetype") || "").trim() || "Desktop",
      checkedAt: String(getField(cells, "checkedat", "date", "timestamp") || "").trim(),
    });
  }

  return { ok: true, rows };
}

function escapeCsvCell(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeBaselineCsv(rows = []) {
  const lines = [BASELINE_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.keyword,
        row.manualRanking ?? "",
        row.manualRankingUrl ?? "",
        row.targetLocation ?? "",
        row.latitude ?? "",
        row.longitude ?? "",
        row.device ?? "Desktop",
        row.checkedAt ?? "",
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function createDefaultValidationState() {
  return {
    tolerance: 1,
    deviceType: "Desktop",
    baselineRows: [],
    comparisonReport: null,
  };
}

export async function loadValidationState(storageClient) {
  const res = await storageClient.get(VALIDATION_STORAGE_KEY);
  const saved = res?.[VALIDATION_STORAGE_KEY];
  if (!saved || typeof saved !== "object") {
    return createDefaultValidationState();
  }
  return {
    ...createDefaultValidationState(),
    ...saved,
    baselineRows: Array.isArray(saved.baselineRows) ? saved.baselineRows : [],
  };
}

export async function saveValidationState(storageClient, nextState) {
  const normalized = {
    ...createDefaultValidationState(),
    ...nextState,
    baselineRows: Array.isArray(nextState?.baselineRows) ? nextState.baselineRows : [],
  };
  await storageClient.set({ [VALIDATION_STORAGE_KEY]: normalized });
  return normalized;
}

export async function clearValidationState(storageClient) {
  return saveValidationState(storageClient, createDefaultValidationState());
}

