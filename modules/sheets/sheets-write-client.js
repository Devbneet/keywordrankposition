/**
 * Opt-in Google Sheets v4 BatchUpdate write client.
 * Supports three explicit modes: "mock", "sandbox", and "production",
 * defaults to dryRun (never writes live sheets unapproved), and prevents
 * blind retries on network timeout so callers reconcile before re-running.
 */

import { SHEETS_API_BASE } from "./sheets-api-client.js";

export const UPDATE_MODES = Object.freeze({
  DRY_RUN: "dry-run",
  MOCK: "mock",
  SANDBOX: "sandbox",
  PRODUCTION: "production",
});

export function createSheetsWriteClient({
  authClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  sandboxSpreadsheetIds = [],
  isSandboxSpreadsheetAllowed = null,
  productionWritesEnabled = false,
} = {}) {
  if (!authClient) {
    throw new Error("authClient is required for createSheetsWriteClient.");
  }

  const trustedSandboxIds = new Set(
    Array.isArray(sandboxSpreadsheetIds) ? sandboxSpreadsheetIds.map((id) => String(id || "").trim()).filter(Boolean) : []
  );

  async function executeBatchUpdate({
    spreadsheetId,
    requests,
    mode = UPDATE_MODES.DRY_RUN,
    dryRun = true,
    productionApproved = false,
  } = {}) {
    const allowedModes = new Set(Object.values(UPDATE_MODES));
    if (!allowedModes.has(mode)) {
      return {
        ok: false,
        code: "INVALID_EXECUTION_MODE",
        error: `Unsupported Google Sheets execution mode '${String(mode)}'.`,
      };
    }

    if (dryRun || mode === UPDATE_MODES.DRY_RUN) {
      return {
        ok: false,
        dryRunBlocked: true,
        error: "Dry-run mode is active. Switch off dry-run and confirm the preview before writing.",
      };
    }

    if (mode === UPDATE_MODES.MOCK) {
      return {
        ok: true,
        mocked: true,
        data: { spreadsheetId, replies: [] },
      };
    }

    if (!spreadsheetId || !Array.isArray(requests) || requests.length === 0) {
      return { ok: false, error: "Valid spreadsheetId and non-empty batchUpdate requests are required." };
    }

    if (mode === UPDATE_MODES.SANDBOX) {
      const allowedByStatic = trustedSandboxIds.has(spreadsheetId);
      const allowedByStore =
        !allowedByStatic && typeof isSandboxSpreadsheetAllowed === "function"
          ? Boolean(await isSandboxSpreadsheetAllowed(spreadsheetId))
          : false;
      if (!allowedByStatic && !allowedByStore) {
        return {
          ok: false,
          code: "SANDBOX_SPREADSHEET_NOT_ALLOWED",
          error: `Spreadsheet '${spreadsheetId}' is not in the trusted sandbox allowlist.`,
        };
      }
    }

    if (mode === UPDATE_MODES.PRODUCTION) {
      if (productionWritesEnabled !== true || productionApproved !== true) {
        return {
          ok: false,
          code: "PRODUCTION_WRITES_DISABLED",
          error: "Production Google Sheets writes are disabled until sandbox verification and explicit owner approval are completed.",
        };
      }
    }

    const tokRes = await authClient.getValidToken({
      interactive: false,
      forceRefresh: false,
      writeAccess: true,
    });
    if (!tokRes.ok) {
      return {
        ok: false,
        code: tokRes.code || "WRITE_AUTH_REQUIRED",
        error: tokRes.error || "Google Sheets write permission is not enabled.",
      };
    }

    if (!fetchImpl) {
      return { ok: false, code: "NO_FETCH", error: "Fetch API unavailable." };
    }

    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;

    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokRes.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests,
          includeSpreadsheetInResponse: false,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, data };
      }

      const bodyText = await res.text().catch(() => "");
      if (res.status === 401) {
        await authClient.markTokenExpired("Write token expired or invalid (HTTP 401).");
        return { ok: false, httpStatus: 401, code: "UNAUTHORIZED", error: "OAuth token expired (HTTP 401)." };
      }
      if (res.status === 403) {
        const isProtected = /protected/i.test(bodyText);
        return {
          ok: false,
          httpStatus: 403,
          code: isProtected ? "PROTECTED_RANGE" : "PERMISSION_DENIED",
          error: isProtected
            ? "Target range is protected in Google Sheets (HTTP 403)."
            : `Permission denied when writing to spreadsheet (HTTP 403): ${bodyText}`,
        };
      }
      if (res.status === 404) {
        return { ok: false, httpStatus: 404, code: "NOT_FOUND", error: "Target spreadsheet not found (HTTP 404)." };
      }
      if (res.status === 429) {
        return { ok: false, httpStatus: 429, code: "QUOTA_EXCEEDED", error: "Google Sheets write quota exceeded (HTTP 429)." };
      }
      if (res.status >= 500) {
        // Server error: uncertain whether applied -> caller must re-read & reconcile!
        return {
          ok: false,
          httpStatus: res.status,
          ambiguousOutcome: true,
          code: "SERVER_ERROR",
          error: `Google Sheets returned HTTP ${res.status}. Re-read and reconcile before retrying.`,
        };
      }

      return {
        ok: false,
        httpStatus: res.status,
        code: "INVALID_REQUEST",
        error: `Google Sheets batchUpdate failed (HTTP ${res.status}): ${bodyText}`,
      };
    } catch (error) {
      // Timed out or dropped connection: NEVER blindly retry column insertion!
      return {
        ok: false,
        ambiguousOutcome: true,
        code: "NETWORK_OR_TIMEOUT",
        error: `Write request network failure / response lost (${error instanceof Error ? error.message : String(error)}). Re-read sheet to reconcile.`,
      };
    }
  }

  return {
    executeBatchUpdate,
  };
}

