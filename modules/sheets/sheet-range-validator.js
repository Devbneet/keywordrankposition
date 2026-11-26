/**
 * Range and worksheet collision validator across multiple client locations.
 * Normalizes spreadsheet IDs, worksheet IDs, worksheet names, and A1/column ranges
 * so overlapping ranges (e.g. H vs G:J, H2:H50 vs H1:H100) are always detected.
 */

export function columnLettersToIndex(letters) {
  const clean = String(letters || "").trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(clean)) return null;
  let num = 0;
  for (let i = 0; i < clean.length; i += 1) {
    num = num * 26 + (clean.charCodeAt(i) - 64);
  }
  return num;
}

export function indexToColumnLetters(index) {
  let num = Number(index);
  if (!Number.isFinite(num) || num < 1) return "";
  let out = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    num = Math.floor((num - 1) / 26);
  }
  return out;
}

/**
 * Parse a column letter ("H"), column span ("H:K"), or A1 range ("Sheet!H2:I50" / "H2:I50")
 * into inclusive numeric bounding boxes for overlap comparison.
 */
export function parseRangeBounds(rangeRef, fallbackColumn = "H") {
  let raw = String(rangeRef || fallbackColumn || "H").trim();
  const bangIdx = raw.lastIndexOf("!");
  if (bangIdx !== -1) {
    raw = raw.slice(bangIdx + 1).trim();
  }

  const parts = raw.split(":");
  const parseCell = (part) => {
    const m = /^([A-Za-z]{1,3})(\d+)?$/.exec(part.trim());
    if (!m) return null;
    return {
      col: columnLettersToIndex(m[1]),
      row: m[2] ? Number(m[2]) : null,
    };
  };

  if (parts.length === 1) {
    const c = parseCell(parts[0]);
    if (!c || !c.col) return null;
    return {
      startCol: c.col,
      endCol: c.col,
      startRow: c.row ?? 1,
      endRow: c.row ?? Infinity,
    };
  }

  if (parts.length === 2) {
    const a = parseCell(parts[0]);
    const b = parseCell(parts[1]);
    if (!a || !b || !a.col || !b.col) return null;
    return {
      startCol: Math.min(a.col, b.col),
      endCol: Math.max(a.col, b.col),
      startRow: a.row && b.row ? Math.min(a.row, b.row) : a.row ?? b.row ?? 1,
      endRow: a.row && b.row ? Math.max(a.row, b.row) : Infinity,
    };
  }

  return null;
}

export function doRangeBoundsOverlap(a, b) {
  if (!a || !b) return true;
  const colOverlap = a.startCol <= b.endCol && b.startCol <= a.endCol;
  const rowOverlap = a.startRow <= b.endRow && b.startRow <= a.endRow;
  return colOverlap && rowOverlap;
}

/**
 * Prevent multiple locations under the same client from owning overlapping ranges
 * or colliding on the same worksheet unless explicitly separated cleanly.
 */
export function validateLocationWorksheetIsolation({ sheetConfig, locations = [] }) {
  if (locations.length <= 1) {
    return { valid: true, collisions: [] };
  }

  const spreadsheetScope = String(sheetConfig?.spreadsheetId || "").trim().toLowerCase() || "default";
  const hasExplicitConfig =
    Boolean(sheetConfig?.spreadsheetId) ||
    locations.some((loc) => Boolean(loc.worksheetName || loc.worksheetId || loc.reportingRange));

  if (!hasExplicitConfig) {
    return { valid: true, collisions: [] };
  }

  const collisions = [];

  for (let i = 0; i < locations.length; i += 1) {
    for (let j = i + 1; j < locations.length; j += 1) {
      const a = locations[i];
      const b = locations[j];
      const ovA = sheetConfig?.locationSheetMappings?.[a.locationId] || {};
      const ovB = sheetConfig?.locationSheetMappings?.[b.locationId] || {};

      const wsIdA = String(a.worksheetId || ovA.worksheetId || "").trim();
      const wsIdB = String(b.worksheetId || ovB.worksheetId || "").trim();
      const wsNameA = String(a.worksheetName || ovA.worksheetName || sheetConfig?.worksheetName || "Keywords").trim().toLowerCase();
      const wsNameB = String(b.worksheetName || ovB.worksheetName || sheetConfig?.worksheetName || "Keywords").trim().toLowerCase();

      const sameWorksheet = (wsIdA && wsIdB && wsIdA === wsIdB) || wsNameA === wsNameB;
      if (!sameWorksheet) {
        continue;
      }

      const rangeStrA = String(a.reportingRange || ovA.latestDateColumn || sheetConfig?.latestDateColumn || "H").trim();
      const rangeStrB = String(b.reportingRange || ovB.latestDateColumn || sheetConfig?.latestDateColumn || "H").trim();
      const boundsA = parseRangeBounds(rangeStrA);
      const boundsB = parseRangeBounds(rangeStrB);

      if (doRangeBoundsOverlap(boundsA, boundsB)) {
        collisions.push(
          `Locations '${a.locationName}' and '${b.locationName}' overlap on worksheet '${wsNameA}' (${spreadsheetScope}: ${rangeStrA} vs ${rangeStrB}).`
        );
      } else if (!a.sharedWorksheetStrategy && !b.sharedWorksheetStrategy) {
        // Because Phase 9 inserts entire date columns across all keyword groups on a sheet,
        // two locations on the exact same worksheet require explicit non-overlapping strategy or separate tabs.
        collisions.push(
          `Locations '${a.locationName}' and '${b.locationName}' target the same worksheet '${wsNameA}'. Assign separate worksheets or enable an explicit sharedWorksheetStrategy.`
        );
      }
    }
  }

  return {
    valid: collisions.length === 0,
    collisions,
  };
}

