import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import { validateReportedCoords } from "../modules/location/geolocation-verifier.js";
import {
  buildGoogleLocationCheckUrl,
  inspectGoogleSearchHtml,
} from "../modules/location/google-location-verifier.js";
import {
  GOOGLE_LOCATION_STATUSES,
  LOCATION_STATES,
} from "../modules/location/location-state.js";
import { createStorageClient } from "../modules/storage/storage.js";
import { handleRuntimeMessage } from "../background/service-worker.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function createPhase3MockChrome({
  htmlByUrl = {},
  defaultHtml = readFixture("google_location_device_match.html"),
  probeOverride = null,
  initialTabs = [],
} = {}) {
  const store = new Map();
  const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
  let nextTabId = 200;
  const attachedTabs = new Set();
  const updatedUrls = [];

  return {
    _tabs: tabs,
    _attachedTabs: attachedTabs,
    _updatedUrls: updatedUrls,
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
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return { ...tabs.get(tabId) };
      },
      async query({ url } = {}) {
        const list = [...tabs.values()];
        return url ? list.filter((t) => t.url === url) : list;
      },
      async create(opts) {
        const tab = { id: ++nextTabId, status: "complete", active: true, ...opts };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId, opts) {
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        const updated = { ...tabs.get(tabId), ...opts };
        if (opts.url) updatedUrls.push({ tabId, url: opts.url });
        tabs.set(tabId, updated);
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
      async attach({ tabId }, _version) {
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
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
          const html = htmlByUrl[tab.url] || defaultHtml;
          return {
            result: {
              value: {
                html,
                pageUrl: tab.url,
                triggeredUpdateControl: params.expression.includes("true"),
              },
            },
          };
        }
        return {};
      },
    },
  };
}

test("rejects missing or invalid reported GPS coordinates (null, empty string, NaN, out-of-range)", () => {
  assert.equal(validateReportedCoords(null).valid, false);
  assert.equal(validateReportedCoords({ latitude: null, longitude: 151.2, accuracy: 20 }).valid, false);
  assert.equal(validateReportedCoords({ latitude: "", longitude: 151.2, accuracy: 20 }).valid, false);
  assert.equal(validateReportedCoords({ latitude: NaN, longitude: 151.2, accuracy: 20 }).valid, false);
  assert.equal(validateReportedCoords({ latitude: -95, longitude: 151.2, accuracy: 20 }).valid, false);
  assert.equal(validateReportedCoords({ latitude: -33.8, longitude: 151.2, accuracy: 0 }).valid, false);
  assert.equal(validateReportedCoords({ latitude: -33.8688, longitude: 151.2093, accuracy: 20 }).valid, true);
});

test("parses matching Google device-based location vs IP-based mismatch vs unavailable vs CAPTCHA", () => {
  const deviceMatch = inspectGoogleSearchHtml({
    html: readFixture("google_location_device_match.html"),
    pageUrl: "https://www.google.com.au/search?q=local+services",
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(deviceMatch.status, GOOGLE_LOCATION_STATUSES.MATCHED);
  assert.equal(deviceMatch.detectedLocation, "Sydney NSW, Australia");
  assert.equal(deviceMatch.locationSource, "From your device");
  assert.equal(deviceMatch.locationSourceType, "device");

  const ipMismatch = inspectGoogleSearchHtml({
    html: readFixture("google_location_ip_mismatch.html"),
    pageUrl: "https://www.google.com.au/search?q=local+services",
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(ipMismatch.status, GOOGLE_LOCATION_STATUSES.MISMATCH);
  assert.equal(ipMismatch.detectedLocation, "Melbourne VIC, Australia");
  assert.equal(ipMismatch.locationSource, "From your IP address");
  assert.equal(ipMismatch.locationSourceType, "ip");
  assert.match(ipMismatch.warning, /IP address/i);

  const unavailable = inspectGoogleSearchHtml({
    html: readFixture("google_location_unavailable.html"),
    pageUrl: "https://www.google.com.au/search?q=local+services",
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(unavailable.status, GOOGLE_LOCATION_STATUSES.UNAVAILABLE);
  assert.equal(unavailable.detectedLocation, null);

  const captcha = inspectGoogleSearchHtml({
    html: readFixture("google_location_captcha.html"),
    pageUrl: "https://www.google.com/sorry/index",
    targetCity: "Sydney",
    targetCountry: "Australia",
  });
  assert.equal(captcha.status, GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED);
  assert.match(captcha.error, /sorry/i);
});

test("Phase 2 fixes: changing test page URL navigates dedicated tab and invalidates stale state", async () => {
  const mockChrome = createPhase3MockChrome({
    initialTabs: [{ id: 1, url: "https://unrelated.example.com/", status: "complete" }],
  });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const first = await controller.applyLocation({
    locationName: "Sydney CBD",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    testPageUrl: "https://example.com/page-1",
  });
  assert.equal(first.ok, true);
  const dedicatedTabId = first.state.tabId;

  const second = await controller.applyLocation({
    locationName: "Sydney CBD",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    testPageUrl: "https://example.com/page-2",
  });
  assert.equal(second.ok, true);
  assert.equal(second.state.tabId, dedicatedTabId);
  assert.equal(second.state.tabUrl, "https://example.com/page-2");
  assert.ok(mockChrome._updatedUrls.some((u) => u.tabId === dedicatedTabId && u.url === "https://example.com/page-2"));
  assert.equal(mockChrome._attachedTabs.has(1), false);
});

test("revalidates actual GPS coordinates on session restore and invalidates stale Google verification on tab navigation", async () => {
  let reportedLat = -33.8688;
  const mockChrome = createPhase3MockChrome({
    probeOverride: () => ({
      ok: true,
      permissionStatus: "granted",
      latitude: reportedLat,
      longitude: 151.2093,
      accuracy: 20,
    }),
  });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const applied = await controller.applyGoogleLocation({
    locationName: "Sydney CBD",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    country: "Australia",
    language: "en-AU",
    googleDomain: "google.com.au",
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.MATCHED);

  // If browser GPS shifts while restored, getStatus() re-verifies GPS and flags LOCATION_MISMATCH
  reportedLat = 0;
  const restored = await controller.getStatus();
  assert.equal(restored.browserGpsStatus, LOCATION_STATES.LOCATION_MISMATCH);

  // If the tab URL changes, handleTabUpdated invalidates previous Google verification
  reportedLat = -33.8688;
  await controller.applyGoogleLocation({
    locationName: "Sydney CBD",
    targetCity: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    country: "Australia",
  });
  const navigated = await controller.handleTabUpdated({
    tabId: applied.state.tabId,
    changeInfo: { url: "https://www.google.com.au/search?q=something+else" },
  });
  assert.equal(navigated.googleLocationStatus, GOOGLE_LOCATION_STATUSES.UNVERIFIED);
  assert.equal(navigated.googleDetectedLocation, null);
});

test("handles Google mismatch, permission denial, invalid reported GPS, debugger disconnect, CAPTCHA, and reset", async () => {
  // 1. Google mismatch
  const mismatchChrome = createPhase3MockChrome({
    defaultHtml: readFixture("google_location_ip_mismatch.html"),
  });
  const mismatchRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: {
        locationName: "Sydney CBD",
        targetCity: "Sydney",
        latitude: -33.8688,
        longitude: 151.2093,
        country: "Australia",
      },
    },
    null,
    mismatchChrome
  );
  assert.equal(mismatchRes.ok, false);
  assert.equal(mismatchRes.state.browserGpsStatus, LOCATION_STATES.GPS_VERIFIED);
  assert.equal(mismatchRes.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.MISMATCH);

  // 2. Permission denial keeps Google status Unverified
  const deniedChrome = createPhase3MockChrome({
    probeOverride: () => ({
      ok: false,
      code: "PERMISSION_DENIED",
      permissionStatus: "denied",
      error: "Permission denied",
    }),
  });
  const deniedRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093, country: "Australia" },
    },
    null,
    deniedChrome
  );
  assert.equal(deniedRes.ok, false);
  assert.equal(deniedRes.state.browserGpsStatus, LOCATION_STATES.PERMISSION_DENIED);
  assert.equal(deniedRes.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.UNVERIFIED);

  // 3. Invalid reported coordinates fail cleanly
  const badCoordChrome = createPhase3MockChrome({
    probeOverride: () => ({ ok: true, permissionStatus: "granted", latitude: null, longitude: 151.2, accuracy: 20 }),
  });
  const badCoordRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093, country: "Australia" },
    },
    null,
    badCoordChrome
  );
  assert.equal(badCoordRes.ok, false);
  assert.equal(badCoordRes.state.browserGpsStatus, LOCATION_STATES.VERIFICATION_FAILED);

  // 4. CAPTCHA stops verification immediately with Search blocked
  const captchaChrome = createPhase3MockChrome({
    defaultHtml: readFixture("google_location_captcha.html"),
  });
  const captchaRes = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093, country: "Australia" },
    },
    null,
    captchaChrome
  );
  assert.equal(captchaRes.ok, false);
  assert.equal(captchaRes.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED);

  // 5. Debugger disconnection & Reset Location
  const okChrome = createPhase3MockChrome();
  const applied = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.GOOGLE_LOCATION_APPLY,
      payload: { targetCity: "Sydney", latitude: -33.8688, longitude: 151.2093, country: "Australia" },
    },
    null,
    okChrome
  );
  assert.equal(applied.ok, true);

  okChrome._attachedTabs.delete(applied.state.tabId);
  const verifyDisconnected = await handleRuntimeMessage(
    { type: MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY },
    null,
    okChrome
  );
  assert.equal(verifyDisconnected.ok, false);
  assert.equal(verifyDisconnected.state.state, LOCATION_STATES.DEBUGGER_DISCONNECTED);

  const resetRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.LOCATION_RESET }, null, okChrome);
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.UNVERIFIED);
  assert.equal(resetRes.state.reportedCoords, null);
  assert.equal(resetRes.state.debuggerAttached, false);
});

test("builds Google location check URLs for supported countries and languages", () => {
  assert.equal(
    buildGoogleLocationCheckUrl({ googleDomain: "google.com.au", country: "Australia", language: "en-AU" }),
    "https://www.google.com.au/search?q=local+services&hl=en-AU&gl=au"
  );
  assert.equal(
    buildGoogleLocationCheckUrl({ googleDomain: "google.co.nz", country: "New Zealand", language: "en-NZ" }),
    "https://www.google.co.nz/search?q=local+services&hl=en-NZ&gl=nz"
  );
});

