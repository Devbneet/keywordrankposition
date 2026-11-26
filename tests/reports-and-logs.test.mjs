import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createActivityLogger, LOG_CATEGORIES } from "../modules/logging/activity-logger.js";
import { generateAgencyCsvReport, REPORT_TYPES } from "../modules/reports/report-generator.js";

function createInMemoryStorage() {
  const map = new Map();
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

test("generateAgencyCsvReport creates all 10 report types cleanly with formula injection sanitization", () => {
  const clients = [{ clientId: "c1", clientName: "Acme", websiteDomain: "acme.com" }];
  const historyRecords = [
    {
      resultId: "r1",
      clientId: "c1",
      locationId: "loc1",
      locationName: "Sydney",
      keywordId: "k1",
      keywordText: "=CMD('calc')", // CSV injection test
      resultStatus: TASK_STATUSES.RANKED,
      rankingPosition: 10,
      sourceMode: "live_bulk",
      isLiveVerified: true,
      timestamp: "2026-11-23T01:00:00.000Z",
    },
    {
      resultId: "r2",
      clientId: "c1",
      locationId: "loc1",
      locationName: "Sydney",
      keywordId: "k1",
      keywordText: "=CMD('calc')",
      resultStatus: TASK_STATUSES.RANKED,
      rankingPosition: 4,
      rankingUrl: "https://acme.com/",
      sourceMode: "live_bulk",
      isLiveVerified: true,
      timestamp: "2026-11-30T01:00:00.000Z",
    },
    {
      resultId: "r3",
      clientId: "c1",
      locationId: "loc1",
      locationName: "Sydney",
      keywordId: "k2",
      keywordText: "+sum(A1:A2)",
      resultStatus: TASK_STATUSES.SEARCH_BLOCKED,
      errorDetails: "CAPTCHA",
      sourceMode: "live_bulk",
      timestamp: "2026-11-30T02:00:00.000Z",
    },
  ];

  const currReport = generateAgencyCsvReport({
    reportType: REPORT_TYPES.CURRENT_RANKINGS,
    clients,
    historyRecords,
  });
  assert.ok(currReport.csv.includes("'=CMD('calc')"));
  assert.ok(currReport.rowCount >= 2);

  for (const rType of Object.values(REPORT_TYPES)) {
    const out = generateAgencyCsvReport({
      reportType: rType,
      clients,
      historyRecords,
      journalEntries: [{ operationId: "op1", clientId: "c1", spreadsheetId: "s1", worksheetName: "SEO", status: "Update successful" }],
      accuracyComparisons: [{ keyword: "seo", baselineRank: 3, extensionRank: 3, status: "Exact match" }],
    });
    assert.ok(out.filename.endsWith(".csv"));
    assert.equal(typeof out.csv, "string");
  }
});

test("activityLogger records categorized events, redacts secrets/Bearer tokens, and exports sanitized CSV", async () => {
  const storageClient = createInMemoryStorage();
  const logger = createActivityLogger({ storageClient, idbFactory: null });

  const logRes = await logger.logEvent({
    category: LOG_CATEGORIES.SHEETS_AUTH_ERROR,
    level: "error",
    clientId: "c1",
    message: "Failed call with Bearer ya29.secret_tok_xyz",
    details: { accessToken: "ya29.supersecret", status: 401 },
  });
  assert.equal(logRes.ok, true);

  const logs = await logger.queryLogs({ category: LOG_CATEGORIES.SHEETS_AUTH_ERROR });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message.includes("ya29.secret_tok_xyz"), false);
  assert.ok(logs[0].message.includes("[REDACTED]"));
  assert.equal(logs[0].details.accessToken, "[REDACTED]");

  const csv = logger.exportLogsAsCsv(logs);
  assert.equal(csv.includes("ya29.supersecret"), false);
});

