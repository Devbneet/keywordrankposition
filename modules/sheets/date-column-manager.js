/**
 * Date formatting (using spreadsheet locale & timezone), duplicate-date detection across
 * repeated headers, and safe column-insertion vs same-date-reuse planning.
 */

import { indexToColumnLetters } from "./sheet-range-validator.js";

function normalizeDateToken(headerText) {
  const clean = String(headerText || "").trim().toLowerCase();
  if (!clean) return "";
  // Standardize "23-November" and "23-Nov" and "23 Nov" -> "23-nov"
  const dm = /^(\d{1,2})[-\s/]([a-z]{3,12})(?:[-\s/](\d{2,4}))?$/.exec(clean);
  if (dm) {
    return `${Number(dm[1])}-${dm[2].slice(0, 3)}${dm[3] ? `-${dm[3].slice(-2)}` : ""}`;
  }
  return clean;
}

export function formatDateForSheet({
  dateInput = new Date(),
  locale = "en-AU",
  timeZone = "UTC",
  existingHeaderPattern = "",
} = {}) {
  let dateObj;
  if (dateInput instanceof Date) {
    dateObj = dateInput;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateInput || "").trim())) {
    const [y, m, d] = String(dateInput).trim().split("-").map(Number);
    dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  } else {
    dateObj = new Date(dateInput || Date.now());
  }

  if (Number.isNaN(dateObj.getTime())) {
    throw new Error(`Invalid reporting date: '${dateInput}'.`);
  }

  const cleanLocale = String(locale || "en-US").replace("_", "-") || "en-US";
  const tz = String(timeZone || "UTC") || "UTC";
  const pattern = String(existingHeaderPattern || "").trim();

  // ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(pattern)) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(dateObj);
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  // Numeric DD/MM/YYYY or MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(pattern)) {
    return new Intl.DateTimeFormat(cleanLocale, {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(dateObj);
  }

  // Short month: "23-Nov" or "23 Nov"
  if (/^\d{1,2}[-\s][A-Za-z]{3}$/.test(pattern)) {
    const sep = pattern.includes("-") ? "-" : " ";
    const parts = new Intl.DateTimeFormat(cleanLocale, {
      timeZone: tz,
      day: "numeric",
      month: "short",
    }).formatToParts(dateObj);
    const d = parts.find((p) => p.type === "day")?.value || "";
    const m = parts.find((p) => p.type === "month")?.value || "";
    return `${d}${sep}${m}`;
  }

  // Default agency template: "30-November"
  const parts = new Intl.DateTimeFormat(cleanLocale, {
    timeZone: tz,
    day: "numeric",
    month: "long",
  }).formatToParts(dateObj);
  const d = parts.find((p) => p.type === "day")?.value || "";
  const m = parts.find((p) => p.type === "month")?.value || "";
  return `${d}-${m}`;
}

export function planDateColumnOperation({
  structure,
  displayRows = [],
  reportingDate = new Date(),
  explicitHeaderLabel = "",
} = {}) {
  const latestDateIdx = (structure.headerRowNumbers?.length || 0) > 0
    ? (() => {
        const colLetters = structure.latestDateColumn || "H";
        let num = 0;
        for (let i = 0; i < colLetters.length; i += 1) {
          num = num * 26 + (colLetters.charCodeAt(i) - 64);
        }
        return Math.max(0, num - 1);
      })()
    : 7;

  const targetDateLabel = explicitHeaderLabel
    ? String(explicitHeaderLabel).trim()
    : formatDateForSheet({
        dateInput: reportingDate,
        locale: structure.locale || "en-AU",
        timeZone: structure.timeZone || "UTC",
        existingHeaderPattern: structure.latestDateHeader || "",
      });

  const targetToken = normalizeDateToken(targetDateLabel);
  const headerRows = structure.headerRowNumbers || [];

  if (headerRows.length === 0) {
    return {
      ok: false,
      action: "BLOCKED",
      error: "No keyword table header row detected; cannot determine where to place the ranking date column.",
    };
  }

  // Check all repeated header rows for latest date consistency & duplicate historical dates
  const latestColumnTokens = new Set();
  for (const hrNum of headerRows) {
    const row = displayRows[hrNum - 1] || [];
    const seenInRow = new Set();
    for (let c = latestDateIdx; c < row.length; c += 1) {
      const cellVal = String(row[c] ?? "").trim();
      if (!cellVal) continue;
      const tok = normalizeDateToken(cellVal);
      if (seenInRow.has(tok)) {
        return {
          ok: false,
          action: "BLOCKED",
          error: `Duplicate date column '${cellVal}' already exists on header row ${hrNum}. Clean up duplicate columns manually before automating.`,
        };
      }
      seenInRow.add(tok);

      if (c > latestDateIdx && tok === targetToken) {
        const colLetter = indexToColumnLetters(c + 1);
        return {
          ok: false,
          action: "BLOCKED",
          error: `Target reporting date '${targetDateLabel}' already exists in historical column ${colLetter}. Historical rankings must not be overwritten.`,
        };
      }
    }
    latestColumnTokens.add(normalizeDateToken(row[latestDateIdx] ?? ""));
  }

  if (latestColumnTokens.size > 1) {
    return {
      ok: false,
      action: "BLOCKED",
      error: "Repeated keyword group headers have inconsistent dates in the latest ranking column. Fix headers manually first.",
    };
  }

  const existingLatestToken = [...latestColumnTokens][0] || "";
  if (existingLatestToken && existingLatestToken === targetToken) {
    return {
      ok: true,
      action: "REUSE_EXISTING_COLUMN",
      willInsertColumn: false,
      targetColIndex: latestDateIdx,
      targetColumnLetter: indexToColumnLetters(latestDateIdx + 1),
      targetDateLabel: String(displayRows[headerRows[0] - 1]?.[latestDateIdx] || targetDateLabel).trim(),
      existingLatestDate: structure.latestDateHeader || "",
    };
  }

  return {
    ok: true,
    action: "INSERT_NEW_COLUMN",
    willInsertColumn: true,
    insertColIndex: latestDateIdx,
    targetColIndex: latestDateIdx,
    targetColumnLetter: indexToColumnLetters(latestDateIdx + 1),
    templateColIndexAfterInsert: latestDateIdx + 1,
    targetDateLabel,
    existingLatestDate: structure.latestDateHeader || "",
  };
}

