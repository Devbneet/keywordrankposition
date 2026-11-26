import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJobManager } from "../modules/jobs/job-manager.js";
import { JOB_STATES, TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import {
  buildKeywordQueue,
  importKeywordsFromBaselineRows,
  parseKeywordCsvInput,
  parseKeywordTextInput,
} from "../modules/jobs/keyword-queue.js";
import {
  computeBulkProgressMetrics,
  exportBulkResultsCsv,
  filterBulkTasks,
  sanitizeCsvCell,
} from "../modules/ranking/bulk-results.js";
import { createStorageClient } from "../modules/storage/storage.js";
import { handleRuntimeMessage } from "../background/service-worker.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function createMockChromeForBulk({
  serpHtml = readFixture("serp_page1_rich.html"),
  googleFooterHtml = readFixture("google_location_device_match.html"),
  onKeywordUrl = null,
  quotaErrorAfter = null,
  failTabOnCall = null,
  detachOnCall = null,
} = {}) {
  const store = new Map();
  const tabs = new Map();
  let nextTabId = 700;
  const attachedTabs = new Set();
  let searchCallCount = 0;
  let setCallCount = 0;

  return {
    _tabs: tabs,
    _attachedTabs: attachedTabs,
    _store: store,
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
          for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        async set(items) {
          setCallCount += 1;
          if (quotaErrorAfter !== null && setCallCount > quotaErrorAfter) {
            const err = new Error("QuotaExceededError: storage quota exceeded");
            err.name = "QuotaExceededError";
            throw err;
          }
          for (const [k, v] of Object.entries(items)) {
            store.set(k, structuredClone(v));
          }
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            store.delete(k);
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
        const updated = { ...tabs.get(tabId), ...opts };
        tabs.set(tabId, updated);
        if (opts.url && !opts.url.includes("q=local+services")) {
          searchCallCount += 1;
          if (failTabOnCall && searchCallCount === failTabOnCall) {
            tabs.delete(tabId);
            throw new Error(`Tab ${tabId} was closed`);
          }
          if (detachOnCall && searchCallCount === detachOnCall) {
            attachedTabs.delete(tabId);
          }
          if (onKeywordUrl) {
            await onKeywordUrl(opts.url, searchCallCount);
          }
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
          const html =
            typeof serpHtml === "function"
              ? serpHtml(tab.url, searchCallCount)
              : tab.url.includes("q=local+services")
                ? googleFooterHtml
                : serpHtml;
          return {
            result: {
              value: { html, pageUrl: tab.url },
            },
          };
        }
        return {};
      },
    },
  };
}

async function verifySydney(mockChrome) {
  const res = await handleRuntimeMessage(
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
      },
    },
    null,
    mockChrome
  );
  assert.equal(res.ok, true);
}

test("keyword-queue preserves duplicates, row positions, and imports from TXT, CSV, and Accuracy Lab", () => {
  const textEntries = parseKeywordTextInput("seo sydney\nweb design\nseo sydney\n");
  assert.equal(textEntries.length, 3);
  assert.deepEqual(textEntries.map((e) => e.rowPosition), [1, 2, 3]);

  const csvEntries = parseKeywordCsvInput("Row,Keyword\n8,seo sydney\n12,seo sydney\n");
  assert.equal(csvEntries.length, 2);
  assert.equal(csvEntries[0].rowPosition, 8);
  assert.equal(csvEntries[1].rowPosition, 12);

  const labEntries = importKeywordsFromBaselineRows([
    { rowIndex: 4, keyword: "alpha" },
    { rowIndex: 9, keyword: "alpha" },
  ]);
  assert.equal(labEntries[0].rowPosition, 5);
  assert.equal(labEntries[1].rowPosition, 10);

  const queue = buildKeywordQueue({
    jobId: "j1",
    keywords: csvEntries,
    clientDomain: "pos1.example.com",
    locationConfig: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093 },
    searchDepth: 10,
  });
  assert.equal(queue.length, 2);
  assert.notEqual(queue[0].taskId, queue[1].taskId);
  assert.equal(queue[0].rowPosition, 8);
  assert.equal(queue[1].rowPosition, 12);
});

test("processes 10, 50, and 100 keyword queues sequentially and persists without full HTML", async () => {
  for (const count of [10, 50, 100]) {
    const mockChrome = createMockChromeForBulk();
    await verifySydney(mockChrome);

    const keywords = Array.from({ length: count }, (_, i) => ({
      keyword: i % 5 === 0 ? "seo agency sydney" : `keyword ${i + 1}`,
      rowPosition: i + 1,
    }));

    const res = await handleRuntimeMessage(
      {
        type: MESSAGE_TYPES.BULK_START,
        payload: {
          websiteDomain: "pos5.example.net",
          keywords,
          searchDepth: 10,
        },
      },
      null,
      mockChrome
    );

    assert.equal(res.ok, true);
    assert.equal(res.job.state, JOB_STATES.COMPLETED);
    assert.equal(res.tasks.length, count);
    assert.equal(res.tasks[0].position, 5);
    assert.equal(res.tasks[count - 1].rowPosition, count);
    assert.equal(res.tasks[0].isLiveVerified, true);
    assert.equal(res.tasks[0].rawHtml, undefined);

    const metrics = computeBulkProgressMetrics(res.job, res.tasks);
    assert.equal(metrics.totalKeywords, count);
    assert.equal(metrics.completedKeywords, count);
    assert.equal(metrics.progressPercentage, 100);
  }
});

test("supports Pause and Resume without repeating completed keywords and Stop preserving partial results", async () => {
  let pausedAlready = false;
  let mockChrome;
  mockChrome = createMockChromeForBulk({
    onKeywordUrl: async (_url, count) => {
      if (count === 2 && !pausedAlready) {
        pausedAlready = true;
        await handleRuntimeMessage({ type: MESSAGE_TYPES.BULK_PAUSE }, null, mockChrome);
      }
    },
  });
  await verifySydney(mockChrome);

  const keywords = [
    { keyword: "kw 1", rowPosition: 1 },
    { keyword: "kw 2", rowPosition: 2 },
    { keyword: "kw 3", rowPosition: 3 },
    { keyword: "kw 4", rowPosition: 4 },
  ];

  const pausedRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords, searchDepth: 10 },
    },
    null,
    mockChrome
  );
  assert.equal(pausedRes.job.state, JOB_STATES.PAUSED);
  assert.equal(pausedRes.tasks[0].status, TASK_STATUSES.RANKED);
  assert.equal(pausedRes.tasks[1].status, TASK_STATUSES.RANKED);
  assert.equal(pausedRes.tasks[2].status, TASK_STATUSES.PENDING);
  assert.equal(pausedRes.tasks[3].status, TASK_STATUSES.PENDING);

  const resumed = await handleRuntimeMessage({ type: MESSAGE_TYPES.BULK_RESUME }, null, mockChrome);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.job.state, JOB_STATES.COMPLETED);
  assert.equal(resumed.tasks.filter((t) => t.status === TASK_STATUSES.RANKED).length, 4);

  // Test Stop after 1 keyword
  let stopChrome;
  stopChrome = createMockChromeForBulk({
    onKeywordUrl: async (_url, count) => {
      if (count === 1) {
        await handleRuntimeMessage({ type: MESSAGE_TYPES.BULK_STOP }, null, stopChrome);
      }
    },
  });
  await verifySydney(stopChrome);
  const stoppedRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords, searchDepth: 10 },
    },
    null,
    stopChrome
  );
  assert.equal(stoppedRes.job.state, JOB_STATES.STOPPED);
  assert.equal(stoppedRes.tasks[0].status, TASK_STATUSES.STOPPED);
  assert.equal(stoppedRes.tasks[1].status, TASK_STATUSES.PENDING);
});

test("stops immediately on CAPTCHA, tab closure, debugger disconnect, and location mismatch without recording NA", async () => {
  // 1. CAPTCHA on 2nd keyword -> 1st ranked, 2nd Search blocked, 3rd stays Pending
  const captchaChrome = createMockChromeForBulk({
    serpHtml: (url, count) => {
      if (url.includes("q=local+services")) return readFixture("google_location_device_match.html");
      return count === 2 ? readFixture("google_location_captcha.html") : readFixture("serp_page1_rich.html");
    },
  });
  await verifySydney(captchaChrome);
  const captchaRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: {
        websiteDomain: "pos1.example.com",
        keywords: ["kw 1", "kw blocked", "kw remaining"],
        searchDepth: 10,
      },
    },
    null,
    captchaChrome
  );
  assert.equal(captchaRes.ok, false);
  assert.equal(captchaRes.job.state, JOB_STATES.SEARCH_BLOCKED);
  assert.equal(captchaRes.tasks[0].status, TASK_STATUSES.RANKED);
  assert.equal(captchaRes.tasks[1].status, TASK_STATUSES.SEARCH_BLOCKED);
  assert.equal(captchaRes.tasks[1].isLiveVerified, false);
  assert.equal(captchaRes.tasks[2].status, TASK_STATUSES.PENDING);

  // 2. Tab closure on 2nd keyword
  const closedTabChrome = createMockChromeForBulk({ failTabOnCall: 2 });
  await verifySydney(closedTabChrome);
  const closedRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords: ["kw 1", "kw 2", "kw 3"], searchDepth: 10 },
    },
    null,
    closedTabChrome
  );
  assert.equal(closedRes.job.state, JOB_STATES.LOCATION_VERIFICATION_FAILED);
  assert.equal(closedRes.tasks[0].status, TASK_STATUSES.RANKED);
  assert.equal(closedRes.tasks[1].status, TASK_STATUSES.LOCATION_UNVERIFIED);
  assert.equal(closedRes.tasks[2].status, TASK_STATUSES.PENDING);

  // 3. Debugger disconnect before 2nd keyword
  const detachChrome = createMockChromeForBulk({ detachOnCall: 1 });
  await verifySydney(detachChrome);
  const detachRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords: ["kw 1", "kw 2"], searchDepth: 10 },
    },
    null,
    detachChrome
  );
  assert.equal(detachRes.job.state, JOB_STATES.LOCATION_VERIFICATION_FAILED);

  // 4. Location mismatch on SERP footer stops job
  const mismatchChrome = createMockChromeForBulk({
    serpHtml: (url) =>
      url.includes("q=local+services")
        ? readFixture("google_location_device_match.html")
        : readFixture("google_location_ip_mismatch.html"),
  });
  await verifySydney(mismatchChrome);
  const mismatchRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords: ["kw 1", "kw 2"], searchDepth: 10 },
    },
    null,
    mismatchChrome
  );
  assert.equal(mismatchRes.job.state, JOB_STATES.LOCATION_VERIFICATION_FAILED);
  assert.equal(mismatchRes.tasks[0].status, TASK_STATUSES.LOCATION_MISMATCH);
});

test("filters bulk results, sanitizes CSV formula injection, and handles storage quota errors", async () => {
  const job = {
    jobId: "j_export",
    state: JOB_STATES.COMPLETED,
    locationConfig: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093 },
    createdAt: "2026-11-26T10:00:00Z",
    completedAt: "2026-11-26T10:01:00Z",
  };
  const tasks = [
    {
      rowPosition: 1,
      keyword: "=CMD('calc')",
      status: TASK_STATUSES.RANKED,
      position: 2,
      rankingUrl: "https://example.com/a",
      checkedResults: 10,
      checkedAt: "2026-11-26T10:00:10Z",
      errorDetails: "",
    },
    {
      rowPosition: 2,
      keyword: "mid keyword",
      status: TASK_STATUSES.RANKED,
      position: 15,
      rankingUrl: "https://example.com/b",
      checkedResults: 20,
      checkedAt: "2026-11-26T10:00:20Z",
      errorDetails: "",
    },
    {
      rowPosition: 3,
      keyword: "missing kw",
      status: TASK_STATUSES.NOT_FOUND,
      position: null,
      rankingUrl: "",
      checkedResults: 50,
      checkedAt: "2026-11-26T10:00:30Z",
      errorDetails: "",
    },
  ];

  assert.equal(filterBulkTasks(tasks, { filterMode: "top3" }).length, 1);
  assert.equal(filterBulkTasks(tasks, { filterMode: "top20" }).length, 2);
  assert.equal(filterBulkTasks(tasks, { filterMode: "not_found" }).length, 1);
  assert.equal(filterBulkTasks(tasks, { searchQuery: "mid" }).length, 1);

  assert.equal(sanitizeCsvCell("=1+1"), "'=1+1");
  assert.equal(sanitizeCsvCell(-33.8688), "-33.8688");
  const csv = exportBulkResultsCsv(job, tasks);
  assert.match(csv, /'=CMD/);
  assert.match(csv, /-33\.8688/);

  // Storage quota error test
  const quotaChrome = createMockChromeForBulk({ quotaErrorAfter: 6 });
  await verifySydney(quotaChrome);
  const quotaRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.BULK_START,
      payload: { websiteDomain: "pos1.example.com", keywords: ["kw 1", "kw 2"], searchDepth: 10 },
    },
    null,
    quotaChrome
  );
  assert.equal(quotaRes.ok, false);
  assert.equal(quotaRes.quotaExceeded, true);
});

