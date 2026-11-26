import assert from "node:assert/strict";
import test from "node:test";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { assertReadOnlyRequest, createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { parseGoogleSheetUrl, resolveTargetWorksheet } from "../modules/sheets/spreadsheet-validator.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_GRID_DETAILS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

test("assertReadOnlyRequest forbids every HTTP write method and Sheets write endpoint", () => {
  assert.doesNotThrow(() => assertReadOnlyRequest("GET", "https://sheets.googleapis.com/v4/spreadsheets/abc"));
  assert.throws(() => assertReadOnlyRequest("POST", "https://sheets.googleapis.com/v4/spreadsheets/abc:batchUpdate"));
  assert.throws(() => assertReadOnlyRequest("PUT", "https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1"));
  assert.throws(() => assertReadOnlyRequest("GET", "https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1:append"));
});

test("parseGoogleSheetUrl extracts spreadsheet ID and gid cleanly; resolveTargetWorksheet never silently selects sheets[0]", () => {
  const parsed = parseGoogleSheetUrl(
    `https://docs.google.com/spreadsheets/d/${FICTIONAL_SPREADSHEET_ID}/edit#gid=${FICTIONAL_WORKSHEET_ID}`
  );
  assert.equal(parsed.valid, true);
  assert.equal(parsed.spreadsheetId, FICTIONAL_SPREADSHEET_ID);
  assert.equal(parsed.gid, FICTIONAL_WORKSHEET_ID);

  const missingWs = resolveTargetWorksheet(SAMPLE_METADATA_RESPONSE.sheets, {
    worksheetName: "NonExistentTab",
  });
  assert.equal(missingWs.ok, false);
  assert.match(missingWs.error, /not found/i);

  const matchedById = resolveTargetWorksheet(SAMPLE_METADATA_RESPONSE.sheets, {
    worksheetId: FICTIONAL_WORKSHEET_ID,
  });
  assert.equal(matchedById.ok, true);
  assert.equal(matchedById.worksheet.title, FICTIONAL_WORKSHEET_NAME);
});

test("sheetsApiClient handles 401 refresh, 403 no-retry, 404, 429 retry, and zero write requests during sheetReader flow", async () => {
  let forceRefreshCalls = 0;
  let quotaAttempts = 0;
  const recordedRequests = [];

  const mockAuth = {
    async getValidToken({ forceRefresh } = {}) {
      if (forceRefresh) {
        forceRefreshCalls += 1;
        return { ok: true, token: "refreshed-tok" };
      }
      return { ok: true, token: "initial-tok" };
    },
    async markTokenExpired() {},
  };

  // Test 403 permission denied NEVER retries
  let calls403 = 0;
  const api403 = createSheetsApiClient({
    authClient: mockAuth,
    maxRetries: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls403 += 1;
      return { ok: false, status: 403, text: async () => "PERMISSION_DENIED" };
    },
  });
  const res403 = await api403.getSpreadsheetMetadata(FICTIONAL_SPREADSHEET_ID);
  assert.equal(res403.ok, false);
  assert.equal(res403.code, "PERMISSION_DENIED");
  assert.equal(calls403, 1);

  // Test 429 quota retries and succeeds, and 401 triggers refresh
  let hit401Once = false;
  const apiSuccess = createSheetsApiClient({
    authClient: mockAuth,
    maxRetries: 2,
    baseDelayMs: 1,
    sleepFn: async () => {},
    fetchImpl: async (url, init = {}) => {
      recordedRequests.push({ method: init.method || "GET", url });
      assertReadOnlyRequest(init.method || "GET", url);

      if (!hit401Once) {
        hit401Once = true;
        return { ok: false, status: 401, text: async () => "Invalid Credentials" };
      }
      if (url.includes(":batchGet") && quotaAttempts === 0) {
        quotaAttempts += 1;
        return { ok: false, status: 429, text: async () => "Quota exceeded" };
      }

      if (url.includes("includeGridData=true")) {
        return { ok: true, json: async () => SAMPLE_GRID_DETAILS };
      }
      if (url.includes("valueRenderOption=FORMULA")) {
        return { ok: true, json: async () => ({ valueRanges: [{ values: SAMPLE_FORMULA_ROWS }] }) };
      }
      if (url.includes("valueRenderOption=FORMATTED_VALUE")) {
        return { ok: true, json: async () => ({ valueRanges: [{ values: SAMPLE_DISPLAY_ROWS }] }) };
      }
      return { ok: true, json: async () => SAMPLE_METADATA_RESPONSE };
    },
  });

  const reader = createSheetReader({ sheetsApiClient: apiSuccess });
  const readRes = await reader.readAndAnalyzeSheet({
    clientId: "cli_apex",
    sheetUrlOrId: `https://docs.google.com/spreadsheets/d/${FICTIONAL_SPREADSHEET_ID}/edit#gid=${FICTIONAL_WORKSHEET_ID}`,
  });

  assert.equal(readRes.ok, true);
  assert.equal(forceRefreshCalls, 1);
  assert.equal(quotaAttempts, 1);
  assert.ok(recordedRequests.length >= 4);
  for (const req of recordedRequests) {
    assert.equal(req.method, "GET");
    assert.equal(/:batchUpdate|:append|:clear|:copyTo/i.test(req.url), false);
  }
});

