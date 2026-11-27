import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleRuntimeMessage } from "../background/service-worker.js";
import { ASSISTED_STATES } from "../modules/jobs/sequential-assisted-runner.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function createAssistedMockChrome({ htmlRef }) {
  const store = new Map();
  const tabs = new Map();
  let nextTabId = 10;
  const attachedTabs = new Set();

  return {
    _tabs: tabs,
    runtime: {
      getManifest: () => ({ version: "1.0.0", oauth2: { client_id: "123.apps.googleusercontent.com", scopes: [] } }),
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
          const out = {};
          for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
            if (store.has(k)) out[k] = structuredClone(store.get(k));
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab ${id}`);
        return { ...tabs.get(id) };
      },
      async query() { return []; },
      async create(o) {
        const t = { id: ++nextTabId, status: "complete", active: true, ...o };
        tabs.set(t.id, t);
        return { ...t };
      },
      async update(id, o) {
        const updated = { ...tabs.get(id), ...o };
        tabs.set(id, updated);
        return { ...updated };
      },
    },
    debugger: {
      async getTargets() {
        return [...tabs.keys()].map((tabId) => ({ tabId, attached: attachedTabs.has(tabId) }));
      },
      async attach({ tabId }) { attachedTabs.add(tabId); },
      async detach({ tabId }) { attachedTabs.delete(tabId); },
      async sendCommand({ tabId }, method, params) {
        if (method === "Emulation.setGeolocationOverride") {
          tabs.get(tabId)._geo = { ...params };
          return {};
        }
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("navigator.geolocation")) {
            const g = tabs.get(tabId)._geo;
            return { result: { value: { ok: true, permissionStatus: "granted", latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy } } };
          }
          return { result: { value: { html: htmlRef.current, pageUrl: tabs.get(tabId).url, triggeredUpdateControl: false } } };
        }
        return {};
      },
    },
  };
}

test("Sequential Assisted Workflow: processes 1 keyword at a time on 1 tab, stops on match, pauses on CAPTCHA, and enforces controls", async () => {
  const htmlRef = { current: readFixture("google_location_device_match.html") };
  const mockChrome = createAssistedMockChrome({ htmlRef });

  // Create client + location
  const cli = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.CLIENT_CREATE,
      payload: { clientName: "Assisted Client", websiteDomain: "pos20.example.com" },
    },
    null,
    mockChrome
  );
  const loc = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.CLIENT_ADD_LOCATION,
      payload: {
        clientId: cli.client.clientId,
        locationName: "Sydney",
        targetCity: "Sydney",
        country: "Australia",
        latitude: -33.8688,
        longitude: 151.2093,
      },
    },
    null,
    mockChrome
  );

  // Verify browser GPS & Google location on single dedicated tab
  const gLoc = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: {
        locationName: "Sydney",
        targetCity: "Sydney",
        country: "Australia",
        latitude: -33.8688,
        longitude: 151.2093,
      },
    },
    null,
    mockChrome
  );
  assert.equal(gLoc.ok, true);

  // Start user-controlled assisted workflow (isAuthorized=false -> user navigates manually)
  const startRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.ASSISTED_START,
      payload: {
        clientId: cli.client.clientId,
        locationId: loc.location.locationId,
        keywords: [
          { keyword: "seo agency sydney", rowPosition: 7 },
          { keyword: "second keyword", rowPosition: 8 },
        ],
        searchDepth: 50,
        autoUpdateSheet: false,
        isAuthorized: false,
      },
    },
    null,
    mockChrome
  );
  assert.equal(startRes.ok, true);
  assert.equal(startRes.session.status, ASSISTED_STATES.AWAITING_USER_SEARCH);
  assert.equal(mockChrome._tabs.size, 1); // Strictly 1 dedicated tab

  // Cannot advance to nextKeyword before current keyword completes
  const prematureNext = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_NEXT_KEYWORD }, null, mockChrome);
  assert.equal(prematureNext.ok, false);

  // Inspect Page 1 -> target not on page 1, awaits page 2
  htmlRef.current = readFixture("serp_page1_rich.html");
  const p1 = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_INSPECT_PAGE }, null, mockChrome);
  assert.equal(p1.ok, true);
  assert.equal(p1.keywordFinished, false);
  assert.equal(p1.session.currentPageNumber, 2);
  assert.equal(p1.session.checkedResults, 10);

  // Inspect Page 2 -> target found at #20 -> stops checking current keyword immediately!
  mockChrome._tabs.get(startRes.session.tabId).url = "https://www.google.com.au/search?q=seo+agency+sydney&start=10";
  htmlRef.current = readFixture("serp_page2_rich.html");
  const p2 = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_INSPECT_PAGE }, null, mockChrome);
  assert.equal(p2.ok, true);
  assert.equal(p2.keywordFinished, true, JSON.stringify({ status: p2.session?.status, err: p2.session?.lastError, pages: p2.session?.accumulatedPages?.length, checked: p2.session?.checkedResults }));
  assert.equal(p2.session.status, ASSISTED_STATES.TARGET_FOUND);
  assert.equal(p2.session.currentPosition, 20);
  assert.equal(p2.session.currentRankingUrl, "https://www.pos20.example.com/sydney-seo");
  assert.equal(p2.session.queue[0].status, TASK_STATUSES.RANKED);

  // Pause and Resume
  const paused = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_PAUSE }, null, mockChrome);
  assert.equal(paused.session.status, ASSISTED_STATES.PAUSED);
  const resumed = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_RESUME }, null, mockChrome);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.session.status, ASSISTED_STATES.AWAITING_USER_SEARCH);

  // Advance to Keyword 2
  const nextRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_NEXT_KEYWORD }, null, mockChrome);
  assert.equal(nextRes.ok, true);
  assert.equal(nextRes.session.currentIndex, 1);
  assert.equal(nextRes.session.currentPageNumber, 1);

  // CAPTCHA on Keyword 2 -> immediately pauses without auto-retrying, preserving Keyword 1!
  htmlRef.current = readFixture("google_location_captcha.html");
  const capRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_INSPECT_PAGE }, null, mockChrome);
  assert.equal(capRes.ok, false);
  assert.equal(capRes.captchaPaused, true);
  assert.equal(capRes.session.status, ASSISTED_STATES.CAPTCHA_PAUSED);
  assert.equal(capRes.session.queue[0].status, TASK_STATUSES.RANKED);
  assert.equal(capRes.session.queue[1].status, TASK_STATUSES.PENDING);

  // Stop session cleanly
  const stopRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.ASSISTED_STOP }, null, mockChrome);
  assert.equal(stopRes.ok, true);
  assert.equal(stopRes.session.status, ASSISTED_STATES.STOPPED);
});

