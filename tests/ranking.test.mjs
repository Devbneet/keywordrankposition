import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { isTargetDomainMatch, normalizeDomain } from "../modules/ranking/domain-matcher.js";
import { parseGoogleSerpHtml } from "../modules/ranking/organic-parser.js";
import { calculateOrganicRanking } from "../modules/ranking/ranking-calculator.js";
import { RANKING_STATUSES } from "../modules/ranking/ranking-state.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";
import { createStorageClient } from "../modules/storage/storage.js";
import { handleRuntimeMessage } from "../background/service-worker.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function createRankingMockChrome({
  htmlByUrl = {},
  defaultGoogleHtml = readFixture("google_location_device_match.html"),
  probeOverride = null,
  throwOnUrlPrefix = null,
  detachBeforeRankingEval = false,
  onNavigate = null,
} = {}) {
  const store = new Map();
  const tabs = new Map();
  let nextTabId = 500;
  const attachedTabs = new Set();

  return {
    _tabs: tabs,
    _attachedTabs: attachedTabs,
    runtime: {
      getManifest() {
        return { version: "0.1.0" };
      },
      getURL(relPath) {
        return `chrome-extension://test-id/${relPath}`;
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return store.has(keys) ? { [keys]: store.get(keys) } : {};
          }
          const out = {};
          for (const key of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
            if (store.has(key)) out[key] = store.get(key);
          }
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) {
            store.set(k, structuredClone(v));
          }
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            store.delete(key);
          }
        },
      },
    },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        return { ...tabs.get(tabId) };
      },
      async query() {
        return [];
      },
      async create(opts) {
        const tab = { id: ++nextTabId, status: "complete", active: true, ...opts };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId, opts) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        if (throwOnUrlPrefix && opts.url && opts.url.includes(throwOnUrlPrefix)) {
          throw new Error("Simulated network error on page load");
        }
        const updated = { ...tabs.get(tabId), ...opts };
        tabs.set(tabId, updated);
        if (onNavigate && opts.url) {
          await onNavigate(opts.url, tabId);
        }
        return { ...updated };
      },
    },
    debugger: {
      async getTargets() {
        return [...tabs.keys()].map((tabId) => ({
          tabId,
          attached: attachedTabs.has(tabId),
        }));
      },
      async attach({ tabId }) {
        attachedTabs.add(tabId);
      },
      async detach({ tabId }) {
        attachedTabs.delete(tabId);
      },
      async sendCommand({ tabId }, method, params) {
        if (!attachedTabs.has(tabId)) {
          throw new Error(`Debugger is not attached to tab ${tabId}`);
        }
        const tab = tabs.get(tabId);
        if (method === "Emulation.setGeolocationOverride") {
          tab._geo = { ...params };
          return {};
        }
        if (method === "Emulation.clearGeolocationOverride") {
          delete tab._geo;
          return {};
        }
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("navigator.geolocation")) {
            if (probeOverride) {
              return { result: { value: probeOverride(tab._geo) } };
            }
            return {
              result: {
                value: {
                  ok: true,
                  permissionStatus: "granted",
                  latitude: tab._geo.latitude,
                  longitude: tab._geo.longitude,
                  accuracy: tab._geo.accuracy,
                },
              },
            };
          }
          if (detachBeforeRankingEval && tab.url.includes("q=seo")) {
            attachedTabs.delete(tabId);
            throw new Error("Debugger detached during page evaluation");
          }
          const matchedKey = Object.keys(htmlByUrl).find((k) => tab.url.includes(k));
          const html = matchedKey ? htmlByUrl[matchedKey] : defaultGoogleHtml;
          return {
            result: {
              value: {
                html,
                pageUrl: tab.url,
              },
            },
          };
        }
        return {};
      },
    },
  };
}

async function setupVerifiedSydneyLocation(mockChrome, overrides = {}) {
  return handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: {
        locationName: "Sydney CBD",
        targetCity: "Sydney",
        latitude: -33.8688,
        longitude: 151.2093,
        accuracy: 20,
        country: "Australia",
        language: "en-AU",
        googleDomain: "google.com.au",
        ...overrides,
      },
    },
    null,
    mockChrome
  );
}

test("domain-matcher supports exact & subdomains and rejects lookalikes", () => {
  assert.equal(normalizeDomain("https://www.Example.com/services"), "example.com");
  assert.equal(isTargetDomainMatch({ resultUrl: "https://example.com/a", targetDomain: "example.com" }), true);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://www.example.com/a", targetDomain: "example.com" }), true);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://blog.example.com/a", targetDomain: "example.com" }), true);
  assert.equal(isTargetDomainMatch({ resultUrl: "https://fakeexample.com/a", targetDomain: "example.com" }), false);
  assert.equal(
    isTargetDomainMatch({ resultUrl: "https://example.com.otherwebsite.com/a", targetDomain: "example.com" }),
    false
  );
});

test("organic-parser excludes ads, shopping, AI overviews, local packs, PAA, carousels, related searches, and sitelinks", () => {
  const page1 = parseGoogleSerpHtml({ html: readFixture("serp_page1_rich.html") });
  assert.equal(page1.ok, true);
  assert.equal(page1.results.length, 10);
  assert.equal(page1.results[0].url, "https://pos1.example.com/");
  assert.equal(page1.results[1].url, "https://competitor-two.com.au/");
  assert.equal(page1.results[2].url, "https://fakeexample.com/");
  assert.equal(page1.results[3].url, "https://example.com.otherwebsite.com/");
  assert.equal(page1.results[4].url, "https://pos5.example.net/services");
  assert.equal(page1.results[9].url, "https://blog.pos10.org/post");
  assert.match(page1.nextPageUrl, /start=10/);
});

test("calculates accurate ranking at positions 1, 5, 10, and 20 across pagination and deduplication", () => {
  const page1 = { ...parseGoogleSerpHtml({ html: readFixture("serp_page1_rich.html") }), pageNumber: 1 };
  const page2 = { ...parseGoogleSerpHtml({ html: readFixture("serp_page2_rich.html") }), pageNumber: 2 };

  const r1 = calculateOrganicRanking({ pages: [page1], targetDomain: "pos1.example.com", requestedDepth: 10 });
  assert.equal(r1.status, RANKING_STATUSES.RANKED);
  assert.equal(r1.position, 1);

  const r5 = calculateOrganicRanking({ pages: [page1], targetDomain: "pos5.example.net", requestedDepth: 10 });
  assert.equal(r5.status, RANKING_STATUSES.RANKED);
  assert.equal(r5.position, 5);

  const r10 = calculateOrganicRanking({ pages: [page1], targetDomain: "pos10.org", requestedDepth: 10 });
  assert.equal(r10.status, RANKING_STATUSES.RANKED);
  assert.equal(r10.position, 10);
  assert.equal(r10.rankingUrl, "https://blog.pos10.org/post");

  // Fake lookalike domains must NOT match example.com on page 1; pos20.example.com matches at #20 via page 2
  const r20 = calculateOrganicRanking({
    pages: [page1, page2],
    targetDomain: "pos20.example.com",
    requestedDepth: 20,
  });
  assert.equal(r20.status, RANKING_STATUSES.RANKED);
  assert.equal(r20.position, 20);
  assert.equal(r20.rankingUrl, "https://www.pos20.example.com/sydney-seo");
  assert.equal(r20.checkedResults, 20);
});

test("rejects partial city matches like 'York' in 'New York' in Google location verifier", async () => {
  const mockChrome = createRankingMockChrome({
    defaultGoogleHtml: '<footer><div id="Wprf1b">New York, NY, USA</div><span> - From your device</span></footer>',
  });
  const res = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: {
        locationName: "York",
        targetCity: "York",
        latitude: 53.9591,
        longitude: -1.0815,
        country: "United Kingdom",
      },
    },
    null,
    mockChrome
  );
  assert.equal(res.ok, false);
  assert.equal(res.state.googleLocationStatus, "Google location mismatch");
});

test("live ranking check paginates to position 20 and enforces verified location gate", async () => {
  const mockChrome = createRankingMockChrome({
    htmlByUrl: {
      "start=10": readFixture("serp_page2_rich.html"),
      "q=seo%20agency%20sydney": readFixture("serp_page1_rich.html"),
    },
  });

  // Unverified location must stop safely before checking
  const unverified = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: { websiteDomain: "pos20.example.com", keyword: "seo agency sydney", searchDepth: 20 },
    },
    null,
    mockChrome
  );
  assert.equal(unverified.ok, false);
  assert.equal(unverified.result.status, RANKING_STATUSES.LOCATION_UNVERIFIED);

  // Verify Sydney location, then check keyword across 2 pages -> Rank #20
  const loc = await setupVerifiedSydneyLocation(mockChrome);
  assert.equal(loc.ok, true);

  const ranked = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: { websiteDomain: "pos20.example.com", keyword: "seo agency sydney", searchDepth: 20 },
    },
    null,
    mockChrome
  );
  assert.equal(ranked.ok, true);
  assert.equal(ranked.result.status, RANKING_STATUSES.RANKED);
  assert.equal(ranked.result.position, 20);
  assert.equal(ranked.result.rankingUrl, "https://www.pos20.example.com/sydney-seo");
  assert.equal(ranked.result.checkedResults, 20);
  assert.equal(ranked.result.resultsTable.length, 20);
});

test("distinguishes incomplete search, empty results, CAPTCHA, location mismatch, debugger disconnect, and user stop", async () => {
  // 1. Incomplete search when page 2 fails network load (never reported as NA)
  const incompleteChrome = createRankingMockChrome({
    htmlByUrl: {
      "q=missing%20site": readFixture("serp_page1_rich.html"),
    },
    throwOnUrlPrefix: "start=10",
  });
  await setupVerifiedSydneyLocation(incompleteChrome);
  const incompleteRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: { websiteDomain: "notfound.org", keyword: "missing site", searchDepth: 20 },
    },
    null,
    incompleteChrome
  );
  assert.equal(incompleteRes.ok, false);
  assert.equal(incompleteRes.result.status, RANKING_STATUSES.INCOMPLETE_SEARCH);
  assert.notEqual(incompleteRes.result.status, RANKING_STATUSES.NOT_FOUND);

  // 2. Confirmed empty results vs invalid empty HTML
  const emptySerpHtml = '<html><body><div id="search">Your search - xyz - did not match any documents.</div></body></html>';
  const confirmedEmpty = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: {
        websiteDomain: "example.com",
        keyword: "xyz",
        searchDepth: 10,
        useManualHtml: true,
        manualSerpHtml: emptySerpHtml,
      },
    },
    null,
    incompleteChrome
  );
  assert.equal(confirmedEmpty.result.status, RANKING_STATUSES.NOT_FOUND);
  assert.equal(confirmedEmpty.result.checkedResults, 0);

  const unconfirmedEmpty = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: {
        websiteDomain: "example.com",
        keyword: "xyz",
        searchDepth: 10,
        useManualHtml: true,
        manualSerpHtml: "<html><body><div id='search'>Unexpected layout</div></body></html>",
      },
    },
    null,
    incompleteChrome
  );
  assert.equal(unconfirmedEmpty.result.status, RANKING_STATUSES.INCOMPLETE_SEARCH);

  const blankHtml = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: {
        websiteDomain: "example.com",
        keyword: "xyz",
        searchDepth: 10,
        useManualHtml: true,
        manualSerpHtml: "   ",
      },
    },
    null,
    incompleteChrome
  );
  assert.equal(blankHtml.result.status, RANKING_STATUSES.PARSING_ERROR);

  // 3. CAPTCHA detection
  const captchaRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: {
        websiteDomain: "example.com",
        keyword: "seo",
        searchDepth: 10,
        useManualHtml: true,
        manualSerpHtml: readFixture("google_location_captcha.html"),
      },
    },
    null,
    incompleteChrome
  );
  assert.equal(captchaRes.result.status, RANKING_STATUSES.SEARCH_BLOCKED);

  // 4. Location mismatch stops live check
  const mismatchChrome = createRankingMockChrome({
    defaultGoogleHtml: readFixture("google_location_ip_mismatch.html"),
  });
  await setupVerifiedSydneyLocation(mismatchChrome);
  const mismatchRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: { websiteDomain: "example.com", keyword: "seo", searchDepth: 10 },
    },
    null,
    mismatchChrome
  );
  assert.equal(mismatchRes.result.status, RANKING_STATUSES.LOCATION_MISMATCH);

  // 5. Debugger disconnection during ranking evaluation
  const detachChrome = createRankingMockChrome({ detachBeforeRankingEval: true });
  await setupVerifiedSydneyLocation(detachChrome);
  const detachRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: { websiteDomain: "example.com", keyword: "seo", searchDepth: 10 },
    },
    null,
    detachChrome
  );
  assert.equal(detachRes.result.status, RANKING_STATUSES.LOCATION_UNVERIFIED);
  assert.match(detachRes.result.errorDetails, /Debugger disconnected/i);

  // 6. User interruption via Stop button
  let checkerRef;
  const stopChrome = createRankingMockChrome({
    htmlByUrl: {
      "q=seo": readFixture("serp_page1_rich.html"),
    },
    onNavigate: async () => {
      if (checkerRef) {
        await checkerRef.stopCheck();
      }
    },
  });
  const storage = createStorageClient(stopChrome.storage.local);
  const locController = createGeolocationController({ chromeApi: stopChrome, storageClient: storage });
  checkerRef = createSingleKeywordChecker({
    chromeApi: stopChrome,
    storageClient: storage,
    locationController: locController,
  });
  await locController.applyGoogleLocation({
    locationName: "Sydney CBD",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    country: "Australia",
  });
  const stoppedRes = await checkerRef.checkRanking({
    websiteDomain: "pos20.example.com",
    keyword: "seo",
    searchDepth: 20,
  });
  assert.equal(stoppedRes.result.status, RANKING_STATUSES.STOPPED_BY_USER);
});
