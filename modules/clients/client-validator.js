/**
 * Validation helpers for agency clients, client locations, and Google Sheet configurations.
 * Reuses coordinate-validator.js and preserves SHEET_REQUIREMENTS.md defaults.
 */

import {
  DEFAULT_ACCURACY_METRES,
  getCountryPreset,
  validateLocationInput,
} from "../location/coordinate-validator.js";
import { normalizeDomain } from "../ranking/domain-matcher.js";
import { SUPPORTED_SEARCH_DEPTHS } from "../ranking/ranking-state.js";
import { validateLocationWorksheetIsolation } from "../sheets/sheet-range-validator.js";

export const DEFAULT_SHEET_COLUMNS = Object.freeze({
  keywordColumn: "C",
  searchVolumeColumn: "D",
  competitionColumn: "E",
  landingPageColumn: "F",
  serpColumn: "G",
  latestDateColumn: "H",
});

export const VALID_CLIENT_STATUSES = Object.freeze(["active", "inactive", "archived"]);

const COLUMN_LETTER_RE = /^[A-Z]{1,2}$/;

export function extractSpreadsheetId(sheetUrlOrId) {
  const raw = String(sheetUrlOrId || "").trim();
  if (!raw) return "";
  const urlMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(raw);
  if (urlMatch) {
    return urlMatch[1];
  }
  return raw;
}

export function normalizeColumnLetter(value, fallback) {
  const cleaned = String(value || fallback || "").trim().toUpperCase();
  return COLUMN_LETTER_RE.test(cleaned) ? cleaned : "";
}

export function validateSheetConfig({
  sheetUrl = "",
  spreadsheetId = "",
  worksheetName = "Keywords",
  worksheetId = "",
  keywordColumn = DEFAULT_SHEET_COLUMNS.keywordColumn,
  searchVolumeColumn = DEFAULT_SHEET_COLUMNS.searchVolumeColumn,
  competitionColumn = DEFAULT_SHEET_COLUMNS.competitionColumn,
  landingPageColumn = DEFAULT_SHEET_COLUMNS.landingPageColumn,
  serpColumn = DEFAULT_SHEET_COLUMNS.serpColumn,
  latestDateColumn = DEFAULT_SHEET_COLUMNS.latestDateColumn,
  locationSheetMappings = {},
} = {}) {
  const errors = [];
  const resolvedId = extractSpreadsheetId(spreadsheetId) || extractSpreadsheetId(sheetUrl);

  const cols = {
    keywordColumn: normalizeColumnLetter(keywordColumn, DEFAULT_SHEET_COLUMNS.keywordColumn),
    searchVolumeColumn: normalizeColumnLetter(searchVolumeColumn, DEFAULT_SHEET_COLUMNS.searchVolumeColumn),
    competitionColumn: normalizeColumnLetter(competitionColumn, DEFAULT_SHEET_COLUMNS.competitionColumn),
    landingPageColumn: normalizeColumnLetter(landingPageColumn, DEFAULT_SHEET_COLUMNS.landingPageColumn),
    serpColumn: normalizeColumnLetter(serpColumn, DEFAULT_SHEET_COLUMNS.serpColumn),
    latestDateColumn: normalizeColumnLetter(latestDateColumn, DEFAULT_SHEET_COLUMNS.latestDateColumn),
  };

  for (const [key, val] of Object.entries(cols)) {
    if (!val) {
      errors.push(`${key} must be a valid column letter (A-ZZ).`);
    }
  }

  const usedCols = Object.values(cols).filter(Boolean);
  if (new Set(usedCols).size !== usedCols.length) {
    errors.push("Google Sheet column mappings must use distinct columns.");
  }

  if (sheetUrl && !/^https:\/\/docs\.google\.com\/spreadsheets\//i.test(String(sheetUrl).trim())) {
    errors.push("Google Sheet URL must point to https://docs.google.com/spreadsheets/...");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      sheetUrl: String(sheetUrl || "").trim(),
      spreadsheetId: resolvedId,
      worksheetName: String(worksheetName || "Keywords").trim() || "Keywords",
      worksheetId: String(worksheetId || "").trim(),
      ...cols,
      locationSheetMappings:
        locationSheetMappings && typeof locationSheetMappings === "object"
          ? { ...locationSheetMappings }
          : {},
    },
  };
}

/**
 * Prevent multiple locations under the same client from targeting the exact same
 * (spreadsheetId, worksheetName, latestDateColumn) cell range.
 */
export function checkLocationSheetRangeCollisions({ sheetConfig, locations = [] }) {
  return validateLocationWorksheetIsolation({ sheetConfig, locations });
}

export function validateClientInput({
  clientId = "",
  clientName,
  websiteDomain,
  websiteUrl = "",
  status = "active",
  notes = "",
  sheetConfig = {},
} = {}) {
  const errors = [];
  const cleanName = String(clientName || "").trim();
  if (!cleanName) {
    errors.push("Client name is required.");
  }

  const cleanDomain = normalizeDomain(websiteDomain || websiteUrl);
  if (!cleanDomain) {
    errors.push("Valid website domain is required (e.g. example.com).");
  }

  let cleanUrl = String(websiteUrl || "").trim();
  if (cleanUrl) {
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("Website URL must use http:// or https://.");
      }
    } catch {
      errors.push("Website URL is invalid.");
    }
  } else if (cleanDomain) {
    cleanUrl = `https://${cleanDomain}/`;
  }

  const cleanStatus = String(status || "active").trim().toLowerCase();
  if (!VALID_CLIENT_STATUSES.includes(cleanStatus)) {
    errors.push(`Client status must be one of ${VALID_CLIENT_STATUSES.join(", ")}.`);
  }

  const sheetResult = validateSheetConfig(sheetConfig || {});
  if (!sheetResult.valid) {
    errors.push(...sheetResult.errors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      clientId: String(clientId || "").trim() || `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      clientName: cleanName,
      websiteDomain: cleanDomain,
      websiteUrl: cleanUrl,
      status: cleanStatus,
      notes: String(notes || "").trim(),
      sheetConfig: sheetResult.value,
    },
  };
}

export function validateClientLocation({
  locationId = "",
  clientId,
  locationName,
  targetCity = "",
  stateRegion = "",
  country = "Australia",
  latitude,
  longitude,
  accuracy = DEFAULT_ACCURACY_METRES,
  language = "",
  googleDomain = "",
  deviceType = "Desktop",
  searchDepth = 50,
  worksheetName = "",
  reportingRange = "",
} = {}) {
  const errors = [];
  if (!String(clientId || "").trim()) {
    errors.push("clientId is required for a client location.");
  }
  if (!String(locationName || "").trim()) {
    errors.push("Location name is required.");
  }

  const preset = getCountryPreset(country);
  const coordRes = validateLocationInput({
    locationName,
    targetCity: targetCity || locationName,
    latitude,
    longitude,
    accuracy,
    country,
    language: language || preset.defaultLanguage,
    googleDomain: googleDomain || preset.googleDomain,
  });

  if (!coordRes.valid) {
    errors.push(...coordRes.errors);
  }

  const depth = Number(searchDepth) || 50;
  if (!SUPPORTED_SEARCH_DEPTHS.includes(depth)) {
    errors.push(`Search depth must be one of ${SUPPORTED_SEARCH_DEPTHS.join(", ")}.`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      locationId: String(locationId || "").trim() || `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      clientId: String(clientId).trim(),
      locationName: coordRes.value.locationName,
      targetCity: coordRes.value.targetCity,
      stateRegion: String(stateRegion || "").trim(),
      country: coordRes.value.country,
      latitude: coordRes.value.latitude,
      longitude: coordRes.value.longitude,
      accuracy: coordRes.value.accuracy,
      language: coordRes.value.language,
      googleDomain: coordRes.value.googleDomain,
      deviceType: String(deviceType || "Desktop").trim() || "Desktop",
      searchDepth: depth,
      worksheetName: String(worksheetName || "").trim(),
      reportingRange: String(reportingRange || "").trim(),
    },
  };
}

