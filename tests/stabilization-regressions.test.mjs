import test from "node:test";
import assert from "node:assert/strict";

import { parseCoordinatePair, validateLocationInput } from "../modules/location/coordinate-validator.js";
import { verifyBrowserGeolocation } from "../modules/location/geolocation-verifier.js";
import { inspectGoogleSearchHtml } from "../modules/location/google-location-verifier.js";
import { GOOGLE_LOCATION_STATUSES, LOCATION_STATES } from "../modules/location/location-state.js";
import { isTargetDomainMatch } from "../modules/ranking/domain-matcher.js";
import { parseGoogleSerpHtml } from "../modules/ranking/organic-parser.js";
import { calculateOrganicRanking } from "../modules/ranking/ranking-calculator.js";
import {
  createCanonicalRankingResult,
  isCanonicalLiveVerified,
  RANKING_STATUSES,
} from "../modules/ranking/ranking-state.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createJobManager } from "../modules/jobs/job-manager.js";
import { JOB_STATES } from "../modules/jobs/job-state.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";
import { createScheduledJobRunner } from "../modules/scheduler/scheduled-job-runner.js";
import { EXECUTION_STATES } from "../modules/scheduler/scheduler-state.js";
import { buildRestoreBatchUpdateRequests } from "../modules/sheets/sheet-backup-manager.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { evaluateTaskUpdatePolicy } from "../modules/sheets/sheet-update-validator.js";
import { createSheetsWriteClient, UPDATE_MODES } from "../modules/sheets/sheets-write-client.js";
import { createStorageClient } from "../modules/storage/storage.js";

function createMemoryChromeStorage() {
  const store = new Map();
  return {
    async get(keys) {
      if (typeof keys === "string") {
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      }
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
        if (store.has(k)) out[k] = structuredClone(store.get(k));
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
      }
    },
  };
}

test("Work Package A: rejects IP-based city match, country-only match, and cross-country identical city for strict ranking", () => {
  const ipCityHtml = `<html><body><footer><span class="Q8LRLc">Sydney NSW, Australia</span><span> - From your IP address</span></footer></body></html>`;
  const ipRes = inspectGoogleSearchHtml({
    html: ipCityHtml,
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(ipRes.status, GOOGLE_LOCATION_STATUSES.NON_DEVICE_MATCH);
  assert.equal(ipRes.strictRankingEligible, false);
  assert.equal(ipRes.locationSourceType, "ip");

  const countryOnlyHtml = `<html><body><footer><span class="Q8LRLc">Australia</span><span> - From your device</span></footer></body></html>`;
  const countryRes = inspectGoogleSearchHtml({
    html: countryOnlyHtml,
    targetCity: "",
    targetCountry: "Australia",
  });
  assert.equal(countryRes.status, GOOGLE_LOCATION_STATUSES.AMBIGUOUS);
  assert.equal(countryRes.strictRankingEligible, false);

  const sydneyCanadaHtml = `<html><body><footer><span class="Q8LRLc">Sydney, NS, Canada</span><span> - From your device</span></footer></body></html>`;
  const crossCountry = inspectGoogleSearchHtml({
    html: sydneyCanadaHtml,
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(crossCountry.status, GOOGLE_LOCATION_STATUSES.MISMATCH);
  assert.equal(crossCountry.strictRankingEligible, false);
});

test("Work Package A: permission denial returns distinct error code & recovery steps, and negative coordinates parse cleanly", async () => {
  const pair = parseCoordinatePair("39.669264, -105.0003303");
  assert.equal(pair.valid, true);
  assert.equal(pair.latitude, 39.669264);
  assert.equal(pair.longitude, -105.0003303);

  const locVal = validateLocationInput({
    locationName: "Denver",
    targetCity: "Denver",
    targetState: "CO",
    country: "United States",
    latitude: pair.latitude,
    longitude: pair.longitude,
  });
  assert.equal(locVal.valid, true);
  assert.equal(locVal.value.targetState, "CO");

  const mockChrome = {
    debugger: {
      async sendCommand() {
        return {
          result: {
            value: {
              ok: false,
              code: "SITE_PERMISSION_BLOCKED",
              permissionStatus: "denied",
              error: "Site-level geolocation permission is blocked.",
            },
          },
        };
      },
    },
  };
  const gpsRes = await verifyBrowserGeolocation({
    tabId: 1,
    expectedLatitude: 39.669264,
    expectedLongitude: -105.0003303,
    chromeApi: mockChrome,
  });
  assert.equal(gpsRes.state, LOCATION_STATES.PERMISSION_DENIED);
  assert.equal(gpsRes.permissionErrorCode, "SITE_PERMISSION_BLOCKED");
  assert.ok(Array.isArray(gpsRes.recoverySteps) && gpsRes.recoverySteps.length >= 2);
});

test("Work Package A & B: stale Google location on SERP page invalidates verification and requires explicit isAuthorized", async () => {
  const storage = createStorageClient(createMemoryChromeStorage());
  await storage.set({
    dm_location_session: {
      state: GOOGLE_LOCATION_STATUSES.MATCHED,
      browserGpsStatus: LOCATION_STATES.GPS_VERIFIED,
      googleLocationStatus: GOOGLE_LOCATION_STATUSES.MATCHED,
      googleLocationSourceType: "device",
      strictRankingEligible: true,
      tabId: 10,
      debuggerAttached: true,
      lastVerifiedAt: new Date().toISOString(),
      googleLastVerifiedAt: new Date().toISOString(),
      config: {
        locationName: "Sydney",
        targetCity: "Sydney",
        latitude: -33.8688,
        longitude: 151.2093,
        accuracy: 20,
        country: "Australia",
        language: "en-AU",
        googleDomain: "google.com.au",
      },
    },
  });

  const mockChrome = {
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async get() {
        return { id: 10, url: "https://www.google.com.au/search?q=test", status: "complete" };
      },
      async update(id, opts) {
        return { id, status: "complete", ...opts };
      },
    },
    debugger: {
      async getTargets() {
        return [{ tabId: 10, attached: true }];
      },
      async sendCommand(_t, method, params) {
        if (method === "Runtime.evaluate" && params.expression.includes("navigator.geolocation")) {
          return {
            result: {
              value: { ok: true, permissionStatus: "granted", latitude: -33.8688, longitude: 151.2093, accuracy: 20 },
            },
          };
        }
        return {
          result: {
            value: {
              html: `<html><body><div id="search"><div class="g"><a href="https://example.com/"><h3>Example</h3></a></div></div></body></html>`,
              pageUrl: "https://www.google.com.au/search?q=test",
            },
          },
        };
      },
    },
  };

  let invalidatedCalled = false;
  const checker = createSingleKeywordChecker({
    chromeApi: mockChrome,
    storageClient: storage,
    locationController: {
      async getStatus() {
        return (await storage.get("dm_location_session")).dm_location_session;
      },
      async recordLiveCheckVerification() {
        invalidatedCalled = true;
      },
    },
  });

  // 1. Default isAuthorized=false must block live search
  const unauth = await checker.checkRanking({
    websiteDomain: "example.com",
    keyword: "test",
    searchDepth: 10,
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.result.status, RANKING_STATUSES.AUTHENTICATION_REQUIRED);

  // 2. Authorized check where SERP page has NO Google location footer must NOT reuse stale MATCHED state
  const noFooter = await checker.checkRanking({
    websiteDomain: "example.com",
    keyword: "test",
    searchDepth: 10,
    isAuthorized: true,
  });
  assert.equal(noFooter.ok, false);
  assert.equal(noFooter.result.status, RANKING_STATUSES.LOCATION_UNVERIFIED);
  assert.equal(noFooter.result.isLiveVerified, false);
  assert.equal(invalidatedCalled, true);

  // 3. JobManager also requires explicit isAuthorized=true
  const jobMgr = createJobManager({
    jobStorage: createJobStorage({ storageClient: storage }),
    locationController: { getStatus: async () => ({}) },
    singleKeywordChecker: checker,
  });
  const unauthBulk = await jobMgr.startJob({
    websiteDomain: "example.com",
    keywords: ["test"],
    searchDepth: 10,
  });
  assert.equal(unauthBulk.ok, false);
  assert.match(unauthBulk.error, /Authorized search access/i);
});

test("Work Package B: missing pagination link never marks Incomplete as Not Found, detects loops, and rejects domain lookalikes", () => {
  const htmlWithoutNext = `<html><body><div id="search">${Array.from(
    { length: 10 },
    (_, i) => `<div class="g"><a href="https://other${i}.org/"><h3>Result ${i}</h3></a></div>`
  ).join("")}</div></body></html>`;

  const parsed = parseGoogleSerpHtml({ html: htmlWithoutNext, pageUrl: "https://www.google.com/search?q=test" });
  assert.equal(parsed.endOfResultsVerified, false);

  const calc = calculateOrganicRanking({
    pages: [{ ...parsed, pageNumber: 1 }],
    targetDomain: "tsrcomsupply.com",
    requestedDepth: 100,
  });
  assert.equal(calc.status, RANKING_STATUSES.INCOMPLETE_SEARCH);

  // Pagination loop detection
  const loopCalc = calculateOrganicRanking({
    pages: [
      { ...parsed, pageNumber: 1, pageUrl: "https://www.google.com/search?q=test&start=0" },
      { ...parsed, pageNumber: 2, pageUrl: "https://www.google.com/search?q=test&start=0" },
    ],
    targetDomain: "tsrcomsupply.com",
    requestedDepth: 50,
  });
  assert.equal(loopCalc.status, RANKING_STATUSES.INCOMPLETE_SEARCH);
  assert.match(loopCalc.errorDetails, /loop/i);

  // Domain lookalike rejections
  assert.equal(isTargetDomainMatch({ resultUrl: "https://tsrcomsupply.com/cabinets/", targetDomain: "tsrcomsupply.com" }), true);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://www.tsrcomsupply.com/", targetDomain: "tsrcomsupply.com" }), true);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://fake-tsrcomsupply.com/", targetDomain: "tsrcomsupply.com" }), false);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://example.com/?target=tsrcomsupply.com", targetDomain: "tsrcomsupply.com" }), false);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://tsrcomsupply.com.example.org/", targetDomain: "tsrcomsupply.com" }), false);
});

test("Work Package C: canonical ranking result rejects undefined/IP/manual verification", () => {
  assert.equal(isCanonicalLiveVerified({ status: RANKING_STATUSES.RANKED }), false);
  assert.equal(
    isCanonicalLiveVerified({
      status: RANKING_STATUSES.RANKED,
      isLiveVerified: true,
      verificationEligibility: true,
      browserGpsStatus: "GPS verified",
      googleLocationStatus: "Google location matched",
      googleLocationSourceType: "ip",
    }),
    false
  );
  const canon = createCanonicalRankingResult({
    keyword: "cabinets",
    targetDomain: "tsrcomsupply.com",
    status: RANKING_STATUSES.RANKED,
    position: 3,
    rankingUrl: "https://tsrcomsupply.com/cabinets/",
    checkedResultsCount: 10,
    isLiveVerified: true,
    browserGpsStatus: "GPS verified",
    googleLocationStatus: "Google location matched",
    googleLocationSourceType: "device",
  });
  assert.equal(canon.actualVerifiedDepth, 10);
  assert.equal(canon.isLiveVerified, true);
  assert.equal(isCanonicalLiveVerified(canon), true);
});

test("Work Package D: concurrent claimExecution race allows exactly 1 winner, and storage failure prevents COMPLETED status", async () => {
  const mem = createMemoryChromeStorage();
  const storageClient = createStorageClient(mem);
  const schedStorage = createScheduleStorage({ storageClient, idbFactory: null });

  await schedStorage.saveExecution({
    executionId: "exec_race_1",
    executionKey: "sched_1::2026-11-27T09:00:00Z",
    scheduleId: "sched_1",
    status: EXECUTION_STATES.QUEUED,
  });

  const claims = await Promise.all([
    schedStorage.claimExecution("exec_race_1", "worker_1"),
    schedStorage.claimExecution("exec_race_1", "worker_2"),
    schedStorage.claimExecution("exec_race_1", "worker_3"),
    schedStorage.claimExecution("exec_race_1", "worker_4"),
    schedStorage.claimExecution("exec_race_1", "worker_5"),
  ]);
  const winners = claims.filter((c) => c.ok);
  const losers = claims.filter((c) => !c.ok && c.alreadyClaimed);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 4);

  // Lock renewal & owner-enforced release
  const acq = await schedStorage.acquireExecutionLock({ lockType: "scheduled", ownerId: "owner_A", ttlMs: 5000 });
  assert.equal(acq.acquired, true);
  const wrongRel = await schedStorage.releaseExecutionLock("owner_B");
  assert.equal(wrongRel.ok, false);
  const ren = await schedStorage.renewExecutionLock("owner_A", 15000);
  assert.equal(ren.ok, true);
  const okRel = await schedStorage.releaseExecutionLock("owner_A");
  assert.equal(okRel.ok, true);

  // Storage failure during scheduledJobRunner must NOT mark job Completed
  let lastSavedJob = null;
  const runner = createScheduledJobRunner({
    clientStorage: {
      getClient: async () => ({ clientId: "c1", clientName: "Demo", websiteDomain: "example.com" }),
      listKeywordsByClient: async () => [{ keywordId: "k1", keyword: "test kw", active: true }],
      saveJobRecord: async (rec) => {
        lastSavedJob = rec;
        return { ok: true };
      },
      saveResultsBatch: async () => ({ ok: false, error: "QuotaExceededError: disk full" }),
    },
    locationManager: {
      listLocations: async () => [{ locationId: "l1", locationName: "Sydney", latitude: -33.86, longitude: 151.2 }],
    },
    keywordManager: {
      listKeywords: async () => [{ keywordId: "k1", keyword: "test kw", active: true }],
    },
    scheduleStorage: schedStorage,
    runKeywordCheck: async () => ({
      status: "Ranked",
      position: 2,
      rankingUrl: "https://example.com/",
      isLiveVerified: true,
      actualResultsChecked: 10,
    }),
  });

  await schedStorage.saveSchedule({
    scheduleId: "sched_store_fail",
    clientId: "c1",
    locationId: "l1",
    isAuthorized: true,
    syncSheetBeforeRun: false,
    testFastDelayMs: 0,
    enabled: true,
  });

  const runRes = await runner.runExecution({
    executionId: "exec_store_fail",
    scheduleId: "sched_store_fail",
    clientId: "c1",
    locationId: "l1",
  });
  assert.equal(runRes.ok, false);
  assert.equal(runRes.execution.status, EXECUTION_STATES.FAILED);
  assert.equal(runRes.execution.clientReports[0].storageFailure, true);
  assert.equal(lastSavedJob?.state, JOB_STATES.INTERRUPTED);
});

test("Work Package E & F: repeated keyword tables get distinct sections, backup preserves userEnteredValue types, and write client validates modes", async () => {
  const displayRows = [
    ["Website Statistics", "", ""],
    ["Authority", "45", ""],
    ["", "", ""],
    ["", "", "Keyword", "Volume", "SERP", "30-Nov"],
    ["", "", "kw one", "100", "", "3"],
    ["", "", ""],
    ["", "", "Keyword", "Volume", "SERP", "30-Nov"],
    ["", "", "kw two", "200", "", "5"],
  ];
  const struct = detectSheetStructure({
    spreadsheetId: "sheet_1",
    worksheetId: "0",
    worksheetName: "Keywords",
    displayRows,
  });
  assert.equal(struct.groups.length, 2);
  assert.notEqual(struct.groups[0].groupName, struct.groups[1].groupName);

  // Update validator rejects manual_html sourceMode & domain mismatch
  const manualDecision = evaluateTaskUpdatePolicy({
    task: { status: "Ranked", position: 1, rankingUrl: "https://example.com/", isLiveVerified: true, sourceMode: "manual_html" },
  });
  assert.equal(manualDecision.writeRank, false);

  // Backup restoration preserves leading-zero strings via userEnteredValue
  const restoreReqs = buildRestoreBatchUpdateRequests({
    worksheetId: 0,
    snapshotData: {
      displayValues: [["00123", "45", "TRUE", "=SUM(A1:B1)", ""]],
      formulaValues: [["00123", "45", "TRUE", "=SUM(A1:B1)", ""]],
      gridData: {
        rowData: [
          {
            values: [
              { userEnteredValue: { stringValue: "00123" } },
              { userEnteredValue: { numberValue: 45 } },
              { userEnteredValue: { boolValue: true } },
              { userEnteredValue: { formulaValue: "=SUM(A1:B1)" } },
              { userEnteredValue: {} },
            ],
          },
        ],
      },
    },
  });
  const cells = restoreReqs[0].updateCells.rows[0].values;
  assert.deepEqual(cells[0].userEnteredValue, { stringValue: "00123" });
  assert.deepEqual(cells[1].userEnteredValue, { numberValue: 45 });
  assert.deepEqual(cells[2].userEnteredValue, { boolValue: true });
  assert.deepEqual(cells[3].userEnteredValue, { formulaValue: "=SUM(A1:B1)" });
  assert.deepEqual(cells[4].userEnteredValue, {});

  // Write client mode allowlist
  let fetched = false;
  const writeClient = createSheetsWriteClient({
    authClient: { getValidToken: async () => ({ ok: true, token: "tok" }) },
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  const badMode = await writeClient.executeBatchUpdate({
    spreadsheetId: "s1",
    requests: [{ insertDimension: {} }],
    mode: "legacy_unsafe_mode",
    dryRun: false,
  });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.code, "INVALID_EXECUTION_MODE");

  const mockMode = await writeClient.executeBatchUpdate({
    spreadsheetId: "s1",
    requests: [{ insertDimension: {} }],
    mode: UPDATE_MODES.MOCK,
    dryRun: false,
  });
  assert.equal(mockMode.ok, true);
  assert.equal(mockMode.mocked, true);
  assert.equal(fetched, false);
});
