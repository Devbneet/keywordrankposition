/**
 * Strictly read-only Google Sheets API v4 REST client (GET only).
 * Implements field masks, FORMATTED_VALUE + FORMULA reading, HTTP error mapping,
 * bounded exponential backoff for transient errors, and zero write endpoints.
 */

export const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export function assertReadOnlyRequest(method, url) {
  const upperMethod = String(method || "GET").toUpperCase();
  if (upperMethod !== "GET") {
    throw new Error(`Read-only Phase 8 restriction: HTTP '${upperMethod}' is forbidden.`);
  }
  const target = String(url || "");
  if (
    target.includes(":batchUpdate") ||
    target.includes(":append") ||
    target.includes(":clear") ||
    target.includes(":copyTo")
  ) {
    throw new Error(`Read-only Phase 8 restriction: write endpoint '${target}' is forbidden.`);
  }
}

function classifySheetsHttpError(status, bodyText) {
  const bodyLower = String(bodyText || "").toLowerCase();
  if (status === 400) {
    return { retryable: false, code: "INVALID_REQUEST", error: `Invalid Sheets API request (HTTP 400): ${bodyText}` };
  }
  if (status === 401) {
    return { retryable: false, authExpired: true, code: "UNAUTHORIZED", error: "Google OAuth token expired or invalid (HTTP 401)." };
  }
  if (status === 403) {
    if (bodyLower.includes("accessnotconfigured") || bodyLower.includes("has not been used in project")) {
      return { retryable: false, code: "API_DISABLED", error: "Google Sheets API is disabled in the Google Cloud project (HTTP 403)." };
    }
    return { retryable: false, code: "PERMISSION_DENIED", error: "Insufficient Google Sheets permissions for this spreadsheet (HTTP 403)." };
  }
  if (status === 404) {
    return { retryable: false, code: "NOT_FOUND", error: "Spreadsheet not found or inaccessible for connected Google account (HTTP 404)." };
  }
  if (status === 429) {
    return { retryable: true, code: "QUOTA_EXCEEDED", error: "Google Sheets API quota exceeded (HTTP 429)." };
  }
  if (status >= 500) {
    return { retryable: true, code: "SERVER_ERROR", error: `Google Sheets temporary server error (HTTP ${status}).` };
  }
  return { retryable: false, code: "HTTP_ERROR", error: `Google Sheets API error (HTTP ${status}): ${bodyText}` };
}

export function createSheetsApiClient({
  authClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  maxRetries = 2,
  baseDelayMs = 250,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!authClient) {
    throw new Error("authClient is required for createSheetsApiClient.");
  }

  async function requestReadOnlyJson(url) {
    assertReadOnlyRequest("GET", url);
    if (!fetchImpl) {
      return { ok: false, code: "NO_FETCH", error: "Fetch API unavailable." };
    }

    let tokenRes = await authClient.getValidToken({ interactive: false, forceRefresh: false });
    if (!tokenRes.ok) {
      return { ok: false, code: tokenRes.code || "AUTH_REQUIRED", error: tokenRes.error };
    }

    let tokenRefreshed = false;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        assertReadOnlyRequest("GET", url);
        const res = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
        });

        if (res.ok) {
          const data = await res.json();
          return { ok: true, data };
        }

        const errText = await res.text().catch(() => "");
        const classified = classifySheetsHttpError(res.status, errText);

        if (classified.authExpired && !tokenRefreshed) {
          tokenRefreshed = true;
          const refreshed = await authClient.getValidToken({ interactive: false, forceRefresh: true });
          if (refreshed.ok) {
            tokenRes = refreshed;
            continue;
          }
          await authClient.markTokenExpired(classified.error);
          return { ok: false, httpStatus: 401, code: classified.code, error: classified.error };
        }

        if (classified.retryable && attempt < maxRetries) {
          attempt += 1;
          await sleepFn(baseDelayMs * Math.pow(2, attempt - 1));
          continue;
        }

        if (classified.authExpired) {
          await authClient.markTokenExpired(classified.error);
        }

        return {
          ok: false,
          httpStatus: res.status,
          code: classified.code,
          error: classified.error,
        };
      } catch (error) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleepFn(baseDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        return {
          ok: false,
          code: "NETWORK_ERROR",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { ok: false, code: "RETRY_EXHAUSTED", error: "Sheets API retries exhausted." };
  }

  async function getSpreadsheetMetadata(spreadsheetId) {
    const fields = [
      "spreadsheetId",
      "properties(title,locale,timeZone)",
      "sheets(properties(sheetId,title,index,gridProperties),merges,protectedRanges,basicFilter,filterViews,conditionalFormats)",
    ].join(",");
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`;
    return requestReadOnlyJson(url);
  }

  async function getSpreadsheetGridDetails(spreadsheetId, ranges = []) {
    const fields = [
      "spreadsheetId",
      "properties(title,locale,timeZone)",
      "sheets(properties(sheetId,title,index,gridProperties),merges,protectedRanges,basicFilter,filterViews,conditionalFormats,data(rowMetadata(pixelSize),columnMetadata(pixelSize),rowData(values(formattedValue,userEnteredValue,effectiveValue,dataValidation,userEnteredFormat(backgroundColor,borders,horizontalAlignment,verticalAlignment,wrapStrategy,numberFormat,textFormat(bold,fontFamily,fontSize,foregroundColor)),effectiveFormat(backgroundColor,borders,horizontalAlignment,verticalAlignment,wrapStrategy,numberFormat,textFormat(bold,fontFamily,fontSize,foregroundColor))))))",
    ].join(",");
    const rangeParams = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?includeGridData=true${rangeParams ? `&${rangeParams}` : ""}&fields=${encodeURIComponent(fields)}`;
    return requestReadOnlyJson(url);
  }

  async function getValues(spreadsheetId, range, { valueRenderOption = "FORMATTED_VALUE" } = {}) {
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=${encodeURIComponent(valueRenderOption)}`;
    return requestReadOnlyJson(url);
  }

  async function batchGetValues(spreadsheetId, ranges = [], { valueRenderOption = "FORMATTED_VALUE" } = {}) {
    const params = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}&valueRenderOption=${encodeURIComponent(valueRenderOption)}`;
    return requestReadOnlyJson(url);
  }

  return {
    getSpreadsheetMetadata,
    getSpreadsheetGridDetails,
    getValues,
    batchGetValues,
  };
}

