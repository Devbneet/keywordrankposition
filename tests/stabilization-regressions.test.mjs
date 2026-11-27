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
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createJobManager } from "../modules/jobs/job-manager.js";
import { recoverInterruptedJob } from "../modules/jobs/job-recovery.js";
import { JOB_STATES, TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";
import { createScheduledJobRunner } from "../modules/scheduler/scheduled-job-runner.js";
import { AUTOMATION_MODES, EXECUTION_STATES } from "../modules/scheduler/scheduler-state.js";
import { buildRestoreBatchUpdateRequests } from "../modules/sheets/sheet-backup-manager.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { evaluateTaskUpdatePolicy } from "../modules/sheets/sheet-update-validator.js";
import { createSheetsWriteClient, UPDATE_MODES } from "../modules/sheets/sheets-write-client.js";
import { createUpdateJournal } from "../modules/sheets/update-journal.js";
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

test("RC3 regression: sheetUpdater blocks missing explicit locationId, writeClient blocks untrusted sandboxAllowlist & unapproved production", async () => {
  const storageClient = createStorageClient(createMemoryChromeStorage());
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });
  const clientManager = createClientManager({ clientStorage, locationManager, keywordManager });

  await clientManager.createClient({
    clientId: "cli_rc3",
    clientName: "RC3 Client",
    websiteDomain: "rc3.example.com",
    sheetConfig: { spreadsheetId: "sheet_rc3", worksheetId: "0", worksheetName: "Keywords" },
  });
  await locationManager.addLocation({
    clientId: "cli_rc3",
    locationId: "loc_rc3_1",
    locationName: "Sydney",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
  });

  const updater = createSheetUpdater({
    clientStorage,
    locationManager,
    sheetsApiClient: {},
    sheetsWriteClient: createSheetsWriteClient({
      authClient: { getValidToken: async () => ({ ok: true, token: "t" }) },
    }),
    sheetReader: {},
    backupManager: { getBackup: async () => null, verifyBackupIntegrity: () => ({ valid: false }) },
    updateJournal: createUpdateJournal({ storageClient, idbFactory: null }),
    authClient: { getStatus: async () => ({ writeAccessEnabled: true }) },
  });

  // Missing explicit locationId must NOT fall back to loc_rc3_1
  const previewMissingLoc = await updater.generatePreview({
    clientId: "cli_rc3",
    locationId: "loc_does_not_exist",
    job: { jobId: "j1", clientId: "cli_rc3", locationId: "loc_does_not_exist" },
    tasks: [],
  });
  assert.equal(previewMissingLoc.ok, false);
  assert.match(previewMissingLoc.error, /not found/i);

  // Caller-supplied sandboxAllowlist must NOT bypass trusted sandboxSpreadsheetIds
  const wc = createSheetsWriteClient({
    authClient: { getValidToken: async () => ({ ok: true, token: "t" }) },
    sandboxSpreadsheetIds: ["trusted_sandbox_sheet"],
    productionWritesEnabled: false,
  });
  const evilSandbox = await wc.executeBatchUpdate({
    spreadsheetId: "evil_untrusted_sheet",
    requests: [{ insertDimension: {} }],
    mode: UPDATE_MODES.SANDBOX,
    dryRun: false,
    sandboxAllowlist: ["evil_untrusted_sheet"],
  });
  assert.equal(evilSandbox.ok, false);
  assert.equal(evilSandbox.code, "SANDBOX_SPREADSHEET_NOT_ALLOWED");

  // Production mode must remain blocked unless BOTH productionWritesEnabled & productionApproved are true
  const prodBlocked = await wc.executeBatchUpdate({
    spreadsheetId: "prod_sheet",
    requests: [{ insertDimension: {} }],
    mode: UPDATE_MODES.PRODUCTION,
    dryRun: false,
    productionApproved: true,
  });
  assert.equal(prodBlocked.ok, false);
  assert.equal(prodBlocked.code, "PRODUCTION_WRITES_DISABLED");
});

test("RC3 regression: sheet-update-validator uses canonical verifiedEndOfResults & actualVerifiedDepth, and backup supports multi-GridData + insertedColumnIndex delete", () => {
  const notFoundCanonical = evaluateTaskUpdatePolicy({
    task: {
      status: TASK_STATUSES.NOT_FOUND,
      requestedDepth: 50,
      actualVerifiedDepth: 12,
      verifiedEndOfResults: true,
      isLiveVerified: true,
    },
  });
  assert.equal(notFoundCanonical.action, "WRITE_NA");
  assert.equal(notFoundCanonical.writeRank, true);

  const notFoundIncomplete = evaluateTaskUpdatePolicy({
    task: {
      status: TASK_STATUSES.NOT_FOUND,
      requestedDepth: 50,
      actualVerifiedDepth: 12,
      verifiedEndOfResults: false,
      isLiveVerified: true,
    },
  });
  assert.equal(notFoundIncomplete.action, "SKIP_FAILED");
  assert.equal(notFoundIncomplete.writeRank, false);

  // Multi-GridData blocks + insertedColumnIndex inverse deleteDimension + hiddenByUser + filterViews
  const reqs = buildRestoreBatchUpdateRequests(
    {
      worksheetId: 0,
      snapshotData: {
        displayValues: [["A", "B"], ["C", "D"], ["E", "F"]],
        formulaValues: [["A", "B"], ["C", "D"], ["E", "F"]],
        filterViews: [{ title: "Saved View", range: { startRowIndex: 0, endRowIndex: 3 } }],
        gridDataBlocks: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [{ values: [{ userEnteredValue: { stringValue: "A" } }, { userEnteredValue: { stringValue: "B" } }] }],
            columnMetadata: [{ pixelSize: 120, hiddenByUser: false }],
          },
          {
            startRow: 2,
            startColumn: 0,
            rowData: [{ values: [{ userEnteredValue: { stringValue: "E" } }, { userEnteredValue: { stringValue: "F" } }] }],
            rowMetadata: [{ pixelSize: 28, hiddenByUser: true }],
          },
        ],
      },
    },
    { insertedColumnIndex: 7 }
  );

  assert.ok(reqs[0].deleteDimension);
  assert.equal(reqs[0].deleteDimension.range.startIndex, 7);
  const updateCellsReqs = reqs.filter((r) => Boolean(r.updateCells));
  assert.equal(updateCellsReqs.length, 2);
  assert.equal(updateCellsReqs[1].updateCells.range.startRowIndex, 2);
  assert.ok(reqs.some((r) => r.addFilterView?.filter?.title === "Saved View"));
  assert.ok(reqs.some((r) => r.updateDimensionProperties?.properties?.hiddenByUser === true));
});

test("RC3 regression: scheduledJobRunner uses reporting timezone date & UPDATE_MODES.PRODUCTION, and jobRecovery sets checkpoint metadata", async () => {
  const mem = createMemoryChromeStorage();
  const storageClient = createStorageClient(mem);
  const schedStorage = createScheduleStorage({ storageClient, idbFactory: null });

  await schedStorage.saveSchedule({
    scheduleId: "sched_tz",
    clientId: "c_tz",
    locationId: "l_tz",
    timezone: "Australia/Sydney",
    automationMode: AUTOMATION_MODES.MODE_B_AUTO_SHEET,
    sandboxMode: false,
    isAuthorized: true,
    syncSheetBeforeRun: false,
    testFastDelayMs: 0,
    enabled: true,
  });
  await schedStorage.saveSchedulerSettings({ unattendedProdSheetWritesEnabled: true });

  let capturedPreviewDate = null;
  let capturedExecuteMode = null;

  const runner = createScheduledJobRunner({
    clientStorage: {
      getClient: async () => ({
        clientId: "c_tz",
        clientName: "TZ Client",
        websiteDomain: "tz.example.com",
        sheetConfig: { spreadsheetId: "sheet_tz", worksheetId: "0" },
      }),
      listKeywordsByClient: async () => [{ keywordId: "k1", keyword: "tz kw", active: true }],
      saveJobRecord: async () => ({ ok: true }),
      saveResultsBatch: async () => ({ ok: true }),
    },
    locationManager: {
      listLocations: async () => [
        { locationId: "l_tz", locationName: "Sydney", reportingTimezone: "Australia/Sydney", latitude: -33.86, longitude: 151.2 },
      ],
    },
    scheduleStorage: schedStorage,
    runKeywordCheck: async () => ({
      status: TASK_STATUSES.RANKED,
      position: 4,
      rankingUrl: "https://tz.example.com/",
      isLiveVerified: true,
      actualResultsChecked: 10,
    }),
    sheetUpdater: {
      generatePreview: async ({ reportingDate }) => {
        capturedPreviewDate = reportingDate;
        return {
          ok: true,
          preview: { spreadsheetId: "sheet_tz", worksheetId: "0", worksheetName: "Keywords", planFingerprint: "fp1" },
          snapshot: { structureFingerprint: "sf1" },
        };
      },
      executeApprovedUpdate: async ({ mode, productionApproved }) => {
        capturedExecuteMode = { mode, productionApproved };
        return { ok: false, code: "PRODUCTION_WRITES_DISABLED" };
      },
    },
    sheetBackupManager: {
      createAndVerifyBackup: async () => ({ ok: true, backup: { backupId: "bkp_1" } }),
    },
  });

  // 2026-11-27T20:00:00Z is 2026-11-28 07:00:00 AEDT in Australia/Sydney
  await runner.runExecution(
    { executionId: "exec_tz", scheduleId: "sched_tz", clientId: "c_tz", locationId: "l_tz" },
    { now: new Date("2026-11-27T20:00:00.000Z") }
  );
  assert.equal(capturedPreviewDate, "2026-11-28");
  assert.equal(capturedExecuteMode.mode, UPDATE_MODES.PRODUCTION);
  assert.equal(capturedExecuteMode.productionApproved, false);

  // Job recovery sets resumableFromCheckpoint, completedCount, pendingCount
  const jobStorage = createJobStorage({ storageClient });
  await jobStorage.saveJobMetadata({ jobId: "j_rec", state: JOB_STATES.RUNNING });
  await jobStorage.saveTaskBatch("j_rec", [
    { taskId: "t1", jobId: "j_rec", status: TASK_STATUSES.RANKED },
    { taskId: "t2", jobId: "j_rec", status: TASK_STATUSES.RUNNING },
  ]);
  const rec = await recoverInterruptedJob({ jobStorage });
  assert.equal(rec.recovered, true);
  assert.equal(rec.job.state, JOB_STATES.RECOVERY_REQUIRED);
  assert.equal(rec.job.resumableFromCheckpoint, true);
  assert.equal(rec.job.completedCount, 1);
  assert.equal(rec.job.pendingCount, 1);
});
