import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { parseGoogleSerpHtml } from "../modules/ranking/organic-parser.js";
import { calculateOrganicRanking } from "../modules/ranking/ranking-calculator.js";
import { RANKING_STATUSES } from "../modules/ranking/ranking-state.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createStorageClient } from "../modules/storage/storage.js";
import {
  COMPARISON_STATUSES,
  compareRankingWithBaseline,
  normalizeComparableUrl,
} from "../modules/validation/accuracy-comparator.js";
import {
  clearValidationState,
  loadValidationState,
  parseBaselineCsv,
  saveValidationState,
  serializeBaselineCsv,
} from "../modules/validation/baseline-manager.js";
import {
  exportComparisonCsv,
  exportComparisonJson,
} from "../modules/validation/comparison-exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function createMemoryStorage() {
  const store = new Map();
  return createStorageClient({
    async get(keys) {
      if (typeof keys === "string") {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
      }
    },
  });
}

function makeExtResult(overrides = {}) {
  return {
    keyword: "seo agency sydney",
    targetWebsite: "example.com",
    position: 3,
    rankingUrl: "https://www.example.com/seo-sydney/",
    checkedResults: 50,
    requestedDepth: 50,
    sourceMode: "live_google",
    isLiveVerified: true,
    deviceType: "Desktop",
    configSnapshot: {
      targetCity: "Sydney",
      latitude: -33.8688,
      longitude: 151.2093,
      country: "Australia",
      language: "en-AU",
    },
    browserGpsStatus: "GPS verified",
    googleLocationStatus: "Google location matched",
    googleLocationSource: "From your device",
    checkedAt: "2026-11-26T10:00:00.000Z",
    status: RANKING_STATUSES.RANKED,
    errorDetails: null,
    invalidatedByLocationChange: false,
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  return {
    rowIndex: 0,
    keyword: "seo agency sydney",
    manualRanking: 3,
    manualRankingUrl: "https://example.com/seo-sydney?utm_source=test",
    targetLocation: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    device: "Desktop",
    checkedAt: "2026-11-26T09:30:00.000Z",
    ...overrides,
  };
}

test("Phase 4 regression: incomplete depth with remaining nextPageUrl cannot return Not Found", () => {
  const page1 = { ...parseGoogleSerpHtml({ html: readFixture("serp_page1_rich.html") }), pageNumber: 1 };
  // Page 1 has 10 results and nextPageUrl; requesting depth 20 without page 2 must be Incomplete search
  const calc = calculateOrganicRanking({
    pages: [page1],
    targetDomain: "missing-domain.org",
    requestedDepth: 20,
  });
  assert.equal(calc.status, RANKING_STATUSES.INCOMPLETE_SEARCH);
  assert.equal(calc.verifiedEndOfResults, false);

  // Genuine end of results (page 2 has no nextPageUrl and domain still absent) returns Not found
  const page2 = { ...parseGoogleSerpHtml({ html: readFixture("serp_page2_rich.html") }), pageNumber: 2 };
  const verifiedEnd = calculateOrganicRanking({
    pages: [page1, page2],
    targetDomain: "missing-domain.org",
    requestedDepth: 50,
  });
  assert.equal(verifiedEnd.status, RANKING_STATUSES.NOT_FOUND);
  assert.equal(verifiedEnd.verifiedEndOfResults, true);
});

test("Phase 4 regression: manual SERP HTML is explicitly labeled not live verified and stale location is rejected", async () => {
  const storage = createMemoryStorage();
  const mockChrome = {
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async get(tabId) {
        if (tabId === 1) {
          return { id: 1, url: "https://www.google.com.au/search?q=local+services", status: "complete" };
        }
        throw new Error("no tab");
      },
      async create(opts) { return { id: 1, status: "complete", ...opts }; },
      async update(id, opts) { return { id, status: "complete", ...opts }; },
    },
    debugger: {
      async getTargets() { return [{ tabId: 1, attached: true }]; },
      async attach() {},
      async detach() {},
      async sendCommand(_target, method) {
        if (method === "Runtime.evaluate") {
          return { result: { value: { ok: true, permissionStatus: "granted", latitude: -33.8688, longitude: 151.2093, accuracy: 20 } } };
        }
        return {};
      },
    },
  };
  const locController = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });
  const checker = createSingleKeywordChecker({
    chromeApi: mockChrome,
    storageClient: storage,
    locationController: locController,
  });

  const manual = await checker.checkRanking({
    websiteDomain: "pos1.example.com",
    keyword: "seo agency sydney",
    searchDepth: 10,
    useManualHtml: true,
    manualSerpHtml: readFixture("serp_page1_rich.html"),
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.result.sourceMode, "manual_html");
  assert.equal(manual.result.isLiveVerified, false);
  assert.match(manual.result.sourceLabel, /Not Live Verified/i);

  // Save stale verified timestamps (2 hours old) and verify live mode rejects stale location
  await storage.set({
    dm_location_session: {
      state: "Google location matched",
      browserGpsStatus: "GPS verified",
      googleLocationStatus: "Google location matched",
      tabId: 1,
      debuggerAttached: true,
      lastVerifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      googleLastVerifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
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

  const staleRes = await checker.checkRanking({
    websiteDomain: "pos1.example.com",
    keyword: "seo agency sydney",
    searchDepth: 10,
    maxLocationAgeMs: 5 * 60 * 1000,
  });
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.result.status, RANKING_STATUSES.LOCATION_UNVERIFIED);
  assert.match(staleRes.result.errorDetails, /stale/i);
});

test("Phase 4 regression: resetting location invalidates saved live ranking results", async () => {
  const storage = createMemoryStorage();
  const mockChrome = {
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async get() { return { id: 1, url: "https://www.google.com.au/", status: "complete" }; },
      async create(opts) { return { id: 1, status: "complete", ...opts }; },
      async update(id, opts) { return { id, status: "complete", ...opts }; },
    },
    debugger: {
      async getTargets() { return [{ tabId: 1, attached: true }]; },
      async attach() {},
      async detach() {},
      async sendCommand() { return {}; },
    },
  };
  const locController = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });
  await storage.set({
    dm_last_ranking_result: {
      isRunning: false,
      activeJobId: null,
      stopRequested: false,
      lastResult: makeExtResult(),
      recentResults: [makeExtResult()],
    },
  });

  await locController.resetLocation();
  const checker = createSingleKeywordChecker({ chromeApi: mockChrome, storageClient: storage, locationController: locController });
  const after = await checker.getState();
  assert.equal(after.lastResult.invalidatedByLocationChange, true);
  assert.equal(after.recentResults[0].invalidatedByLocationChange, true);
});

test("URL normalization removes www, trailing slashes, and tracking parameters", () => {
  assert.equal(
    normalizeComparableUrl("https://www.Example.com/seo-sydney/?utm_source=google&srsltid=123"),
    "example.com/seo-sydney"
  );
  assert.equal(
    normalizeComparableUrl("http://example.com/seo-sydney"),
    "example.com/seo-sydney"
  );
});

test("CSV import/serialize preserves duplicate keywords and all 8 GS Location Changer columns", async () => {
  const csv = [
    "Keyword,Manual Ranking,Manual Ranking URL,Target Location,Latitude,Longitude,Device,Checked At",
    '"seo agency sydney",3,"https://example.com/seo","Sydney",-33.8688,151.2093,Desktop,2026-11-26T09:00:00Z',
    '"seo agency sydney",5,"https://example.com/seo-2","Sydney",-33.8688,151.2093,Desktop,2026-11-26T09:05:00Z',
    '"rare keyword",NA,"","Sydney",-33.8688,151.2093,Desktop,2026-11-26T09:10:00Z',
  ].join("\n");

  const parsed = parseBaselineCsv(csv);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].manualRanking, 3);
  assert.equal(parsed.rows[1].manualRanking, 5);
  assert.equal(parsed.rows[2].manualRanking, "NA");

  const reSerialized = serializeBaselineCsv(parsed.rows);
  const reparsed = parseBaselineCsv(reSerialized);
  assert.equal(reparsed.rows.length, 3);

  const storage = createMemoryStorage();
  await saveValidationState(storage, { tolerance: 2, deviceType: "Desktop", baselineRows: parsed.rows });
  const loaded = await loadValidationState(storage);
  assert.equal(loaded.baselineRows.length, 3);
  await clearValidationState(storage);
  assert.equal((await loadValidationState(storage)).baselineRows.length, 0);
});

test("accuracy comparator classifies all statuses and excludes failures from accuracy percentages", () => {
  const extResults = [
    // 1. Exact match (rank 3 == 3, URL matches after normalization)
    makeExtResult({ keyword: "kw exact", position: 3, rankingUrl: "https://www.example.com/seo" }),
    // 2. Within tolerance (rank 4 vs 3, tolerance 1)
    makeExtResult({ keyword: "kw tol", position: 4, rankingUrl: "https://example.com/tol" }),
    // 3. Ranking mismatch (rank 10 vs 2)
    makeExtResult({ keyword: "kw mismatch", position: 10, rankingUrl: "https://example.com/m" }),
    // 4. URL mismatch (rank 2 == 2, different URL)
    makeExtResult({ keyword: "kw url", position: 2, rankingUrl: "https://example.com/wrong-page" }),
    // 5. Missing baseline
    makeExtResult({ keyword: "kw no baseline", position: 1, rankingUrl: "https://example.com/nb" }),
    // 6. Search blocked (excluded from comparable denominator!)
    makeExtResult({
      keyword: "kw blocked",
      status: RANKING_STATUSES.SEARCH_BLOCKED,
      position: null,
      rankingUrl: null,
      errorDetails: "CAPTCHA",
    }),
    // 7. Incomplete search (excluded from comparable denominator!)
    makeExtResult({
      keyword: "kw incomplete",
      status: RANKING_STATUSES.INCOMPLETE_SEARCH,
      position: null,
      rankingUrl: null,
      errorDetails: "Page 2 failed",
    }),
    // 8. Location mismatch (excluded from comparable denominator!)
    makeExtResult({
      keyword: "kw loc fail",
      status: RANKING_STATUSES.LOCATION_MISMATCH,
      position: null,
      rankingUrl: null,
      errorDetails: "Melbourne != Sydney",
    }),
    // 9. Not comparable (baseline device Mobile != extension Desktop)
    makeExtResult({ keyword: "kw incompat", position: 1, rankingUrl: "https://example.com/i" }),
  ];

  const baselineRows = [
    makeBaseline({ keyword: "kw exact", manualRanking: 3, manualRankingUrl: "https://example.com/seo/" }),
    makeBaseline({ keyword: "kw tol", manualRanking: 3, manualRankingUrl: "https://example.com/tol" }),
    makeBaseline({ keyword: "kw mismatch", manualRanking: 2, manualRankingUrl: "https://example.com/m" }),
    makeBaseline({ keyword: "kw url", manualRanking: 2, manualRankingUrl: "https://example.com/right-page" }),
    makeBaseline({ keyword: "kw blocked", manualRanking: 4 }),
    makeBaseline({ keyword: "kw incomplete", manualRanking: 6 }),
    makeBaseline({ keyword: "kw loc fail", manualRanking: 1 }),
    makeBaseline({ keyword: "kw incompat", manualRanking: 1, device: "Mobile" }),
  ];

  const report = compareRankingWithBaseline({
    keywords: extResults.map((r) => r.keyword),
    extensionResults: extResults,
    baselineRows,
    tolerance: 1,
    settings: { websiteDomain: "example.com", latitude: -33.8688, longitude: 151.2093, deviceType: "Desktop" },
  });

  const byKw = new Map(report.rows.map((r) => [r.keyword, r]));
  assert.equal(byKw.get("kw exact").comparisonStatus, COMPARISON_STATUSES.EXACT_MATCH);
  assert.equal(byKw.get("kw tol").comparisonStatus, COMPARISON_STATUSES.WITHIN_TOLERANCE);
  assert.equal(byKw.get("kw mismatch").comparisonStatus, COMPARISON_STATUSES.RANKING_MISMATCH);
  assert.equal(byKw.get("kw url").comparisonStatus, COMPARISON_STATUSES.URL_MISMATCH);
  assert.equal(byKw.get("kw no baseline").comparisonStatus, COMPARISON_STATUSES.MISSING_BASELINE);
  assert.equal(byKw.get("kw blocked").comparisonStatus, COMPARISON_STATUSES.SEARCH_BLOCKED);
  assert.equal(byKw.get("kw incomplete").comparisonStatus, COMPARISON_STATUSES.INCOMPLETE_SEARCH);
  assert.equal(byKw.get("kw loc fail").comparisonStatus, COMPARISON_STATUSES.LOCATION_MISMATCH);
  assert.equal(byKw.get("kw incompat").comparisonStatus, COMPARISON_STATUSES.NOT_COMPARABLE);

  // Only 4 rows are valid & comparable (exact, tol, mismatch, url)
  assert.equal(report.metrics.totalKeywordsTested, 9);
  assert.equal(report.metrics.comparableKeywords, 4);
  assert.equal(report.metrics.coveragePercentage, 44.44);
  // Ranking accuracy is independent of URL match (kw exact + kw url both have diff === 0)
  assert.equal(report.metrics.exactMatchPercentage, 50); // 2/4
  assert.equal(report.metrics.withinTolerancePercentage, 75); // (2 + 1)/4
  assert.equal(report.metrics.urlMatchPercentage, 75); // 3/4
  assert.equal(report.metrics.averageAbsoluteDifference, 2.25); // (0 + 1 + 8 + 0)/4
  assert.equal(report.metrics.blockedSearchCount, 1);
  assert.equal(report.metrics.incompleteSearchCount, 1);
  assert.equal(report.metrics.locationMismatchCount, 1);
  assert.equal(report.metrics.missingBaselineCount, 1);
  assert.equal(report.metrics.notComparableCount, 1);

  // With tolerance=0, 'kw tol' becomes RANKING_MISMATCH
  const strictReport = compareRankingWithBaseline({
    keywords: ["kw tol"],
    extensionResults: [extResults[1]],
    baselineRows: [baselineRows[1]],
    tolerance: 0,
  });
  assert.equal(strictReport.rows[0].comparisonStatus, COMPARISON_STATUSES.RANKING_MISMATCH);

  // CSV & JSON export
  const csvOut = exportComparisonCsv(report);
  assert.match(csvOut, /Comparison Status/);
  assert.match(csvOut, /kw exact/);
  const jsonOut = JSON.parse(exportComparisonJson(report));
  assert.equal(jsonOut.metrics.comparableKeywords, 4);
});
