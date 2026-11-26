/**
 * Unified Historical Ranking Repository backed by versioned IndexedDB (v4)
 * with safe fallback to chrome.storage.local and idempotent legacy migration.
 */

import { TASK_STATUSES } from "../jobs/job-state.js";
import { createDatabase, STORES } from "../storage/database.js";

export const DEFAULT_AGENCY_SETTINGS = Object.freeze({
  defaultSearchDepth: 50,
  defaultAccuracyMetres: 20,
  defaultCountry: "Australia",
  defaultLanguage: "en",
  comparisonTolerance: 1,
  reportingTimezone: "Australia/Sydney",
  dateFormat: "DD-MMMM",
  developerMode: false,
});

export function normalizeHistoryRecord(raw = {}) {
  const timestamp = raw.timestamp || raw.checkedAt || new Date().toISOString();
  const cleanClientId = raw.clientId || "global";
  const cleanLocId = raw.locationId || raw.locationConfig?.locationId || "loc";
  const cleanTaskKey =
    raw.taskId ||
    raw.keywordId ||
    (raw.keywordText || raw.keyword
      ? `${String(raw.keywordText || raw.keyword).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}_r${raw.rowNumber ?? raw.rowPosition ?? "x"}`
      : "");
  const deterministicResultId =
    raw.jobId && cleanTaskKey
      ? `res_${cleanClientId}_${cleanLocId}_${raw.jobId}_${cleanTaskKey}`
      : null;

  const resultId =
    raw.resultId ||
    deterministicResultId ||
    `res_${cleanClientId}_${raw.jobId || "single"}_${cleanTaskKey || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const { rawHtml: _discardHtml, ...cleanRaw } = raw;
  const sourceMode =
    cleanRaw.sourceMode ||
    (cleanRaw.useManualHtml || cleanRaw.source === "manual_html"
      ? "manual_html"
      : cleanRaw.isMock || cleanRaw.source === "mock"
        ? "mock"
        : cleanRaw.jobId
          ? "live_bulk"
          : "live_single");

  return {
    resultId,
    clientId: cleanRaw.clientId || "unassigned",
    locationId: cleanRaw.locationId || null,
    locationName: cleanRaw.locationName || cleanRaw.locationConfig?.locationName || "",
    keywordId: cleanRaw.keywordId || null,
    keywordGroup: cleanRaw.keywordGroup || "Default",
    searchVolume: cleanRaw.searchVolume ?? "",
    competition: cleanRaw.competition || "",
    landingPage: cleanRaw.landingPage || "",
    spreadsheetRowRef: cleanRaw.spreadsheetRowRef || (cleanRaw.rowNumber || cleanRaw.rowPosition
      ? {
        spreadsheetId: cleanRaw.spreadsheetId || null,
        worksheetId: cleanRaw.worksheetId ?? null,
        worksheetName: cleanRaw.worksheetName || null,
        rowNumber: cleanRaw.rowNumber ?? cleanRaw.rowPosition,
      }
      : null),
    jobId: cleanRaw.jobId || null,
    taskId: cleanRaw.taskId || null,
    keywordText: String(cleanRaw.keywordText || cleanRaw.keyword || "").trim(),
    rankingPosition:
      typeof cleanRaw.rankingPosition === "number"
        ? cleanRaw.rankingPosition
        : typeof cleanRaw.position === "number"
          ? cleanRaw.position
          : null,
    rankingUrl: cleanRaw.rankingUrl || null,
    requestedDepth: Number(cleanRaw.requestedDepth || cleanRaw.searchDepth || 50),
    actualResultsChecked: Number(cleanRaw.actualResultsChecked ?? cleanRaw.checkedResults ?? 0),
    browserGpsVerification: cleanRaw.browserGpsVerification || cleanRaw.gpsStatus || null,
    googleLocationVerification:
      cleanRaw.googleLocationVerification ||
      cleanRaw.locationVerificationStatus ||
      cleanRaw.googleLocationStatus ||
      null,
    googleLocationSource: cleanRaw.googleLocationSource || null,
    deviceType: cleanRaw.deviceType || "Desktop",
    sourceMode,
    isMock: Boolean(cleanRaw.isMock || sourceMode === "mock"),
    isLiveVerified:
      sourceMode === "manual_html" || sourceMode === "mock" || Boolean(cleanRaw.isMock)
        ? false
        : Boolean(cleanRaw.isLiveVerified),
    resultStatus: cleanRaw.resultStatus || cleanRaw.status || TASK_STATUSES.PENDING,
    errorDetails: cleanRaw.errorDetails || null,
    timestamp,
  };
}

export function createHistoryStorage({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  const db = createDatabase({ storageClient, idbFactory });

  async function saveRankingHistoryBatch(records = []) {
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: true, count: 0 };
    }
    const normalized = records.map((r) => normalizeHistoryRecord(r));
    return db.putMany(STORES.RANKING_HISTORY, normalized);
  }

  async function queryRankingHistory({
    clientId = null,
    locationId = null,
    keywordId = null,
    keywordText = "",
    jobId = null,
    dateFrom = "",
    dateTo = "",
    includeManual = false,
    limit = 1000,
  } = {}) {
    let rows;
    if (jobId) {
      rows = await db.getByIndex(STORES.RANKING_HISTORY, "by_job", jobId);
    } else if (keywordId) {
      rows = await db.getByIndex(STORES.RANKING_HISTORY, "by_keyword", keywordId);
    } else if (locationId) {
      rows = await db.getByIndex(STORES.RANKING_HISTORY, "by_location", locationId);
    } else if (clientId) {
      rows = await db.getByIndex(STORES.RANKING_HISTORY, "by_client", clientId);
    } else {
      rows = await db.getAll(STORES.RANKING_HISTORY);
    }

    const qKw = String(keywordText || "").trim().toLowerCase();
    const fromMs = dateFrom ? Date.parse(dateFrom) : null;
    const toMs = dateTo ? Date.parse(dateTo.length <= 10 ? `${dateTo}T23:59:59.999Z` : dateTo) : null;

    const filtered = rows.filter((r) => {
      if (clientId && r.clientId !== clientId) return false;
      if (locationId && r.locationId !== locationId) return false;
      if (keywordId && r.keywordId !== keywordId) return false;
      if (!includeManual && r.sourceMode === "manual_html") return false;
      if (qKw && !String(r.keywordText || "").toLowerCase().includes(qKw)) return false;
      if (fromMs || toMs) {
        const ts = Date.parse(r.timestamp);
        if (fromMs && (!Number.isFinite(ts) || ts < fromMs)) return false;
        if (toMs && (!Number.isFinite(ts) || ts > toMs)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Idempotently migrate legacy client results from STORES.RESULTS (Phase 7-9)
   * into the unified STORES.RANKING_HISTORY repository without creating duplicates.
   */
  async function migrateLegacyResultsToHistory({ clients = [], clientStorage }) {
    if (!clientStorage) return { ok: true, migratedCount: 0 };
    const existingHistory = await db.getAll(STORES.RANKING_HISTORY);
    const seenResultKeys = new Set(
      existingHistory.map((h) => `${h.clientId}::${h.jobId || ""}::${h.taskId || h.resultId}`)
    );

    const toInsert = [];
    for (const c of clients) {
      const legacy = await clientStorage.listResultsByClient(c.clientId);
      for (const r of legacy) {
        const dedupeKey = `${c.clientId}::${r.jobId || ""}::${r.taskId || r.recordKey || ""}`;
        if (seenResultKeys.has(dedupeKey)) continue;
        seenResultKeys.add(dedupeKey);
        toInsert.push(
          normalizeHistoryRecord({
            ...r,
            clientId: c.clientId,
            resultId: r.recordKey ? `mig_${r.recordKey}` : undefined,
          })
        );
      }
    }

    if (toInsert.length === 0) {
      return { ok: true, migratedCount: 0 };
    }
    const saveRes = await saveRankingHistoryBatch(toInsert);
    return { ...saveRes, migratedCount: saveRes.ok ? toInsert.length : 0 };
  }

  async function loadSettings() {
    const saved = await db.getByKey(STORES.SETTINGS, "default_agency_settings");
    return {
      ...DEFAULT_AGENCY_SETTINGS,
      ...(saved?.value || {}),
    };
  }

  async function saveSettings(updates = {}) {
    const prev = await loadSettings();
    const merged = { ...prev, ...updates };
    const res = await db.putOne(STORES.SETTINGS, {
      key: "default_agency_settings",
      value: merged,
      updatedAt: new Date().toISOString(),
    });
    if (!res.ok) return res;
    return { ok: true, settings: merged };
  }

  return {
    saveRankingHistoryBatch,
    queryRankingHistory,
    migrateLegacyResultsToHistory,
    loadSettings,
    saveSettings,
    getSchemaInfo: db.getSchemaInfo,
  };
}

