/**
 * Sanitized structured agency activity log (Phase 10).
 * Never stores access tokens, secrets, passwords, or raw HTTP auth headers.
 */

import { serializeRowsToCsv } from "../reports/csv-exporter.js";
import { createDatabase, STORES } from "../storage/database.js";

export const LOG_CATEGORIES = Object.freeze({
  CLIENT_CONFIG: "client_config",
  LOCATION_VERIFICATION: "location_verification",
  JOB_CREATED: "job_created",
  JOB_COMPLETED: "job_completed",
  JOB_INTERRUPTED: "job_interrupted",
  CAPTCHA_DETECTED: "captcha_detected",
  SHEETS_AUTH_ERROR: "sheets_auth_error",
  KEYWORD_IMPORT: "keyword_import",
  BACKUP_CREATED: "backup_created",
  SHEET_UPDATE: "sheet_update",
  POST_UPDATE_VERIFICATION: "post_update_verification",
  RECOVERY: "recovery",
});

const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|credential|api[_-]?key)/i;

export function redactSensitiveDetails(input) {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return input.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactSensitiveDetails(v));
  }
  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSensitiveDetails(v);
      }
    }
    return out;
  }
  return input;
}

export function createActivityLogger({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  const db = createDatabase({ storageClient, idbFactory });

  async function logEvent({
    category,
    level = "info",
    clientId = null,
    message,
    details = null,
  } = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      logId: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp,
      category: category || "general",
      level,
      clientId,
      message: redactSensitiveDetails(String(message || "")),
      details: details ? redactSensitiveDetails(details) : null,
    };
    const saveRes = await db.putOne(STORES.ACTIVITY_LOGS, entry);
    return saveRes.ok ? { ok: true, entry } : saveRes;
  }

  async function queryLogs({ category = "", clientId = "", level = "", limit = 300 } = {}) {
    let rows = clientId
      ? await db.getByIndex(STORES.ACTIVITY_LOGS, "by_client", clientId)
      : await db.getAll(STORES.ACTIVITY_LOGS);

    rows = rows.filter((r) => {
      if (category && r.category !== category) return false;
      if (level && r.level !== level) return false;
      return true;
    });
    rows.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  function exportLogsAsCsv(logs = []) {
    const headers = ["Timestamp", "Category", "Level", "Client ID", "Message", "Details"];
    const rows = logs.map((l) => [
      l.timestamp,
      l.category,
      l.level,
      l.clientId || "-",
      l.message,
      l.details ? JSON.stringify(l.details) : "",
    ]);
    return serializeRowsToCsv(headers, rows);
  }

  return {
    logEvent,
    queryLogs,
    exportLogsAsCsv,
  };
}

