import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ACCURACY_METRES,
  parseCoordinatePair,
  validateLocationInput,
} from "../modules/location/coordinate-validator.js";
import { createGeolocationController } from "../modules/location/geolocation-controller.js";
import {
  DEFAULT_COORDINATE_TOLERANCE_DEGREES,
} from "../modules/location/geolocation-verifier.js";
import {
  GOOGLE_LOCATION_STATUSES,
  LOCATION_STATES,
} from "../modules/location/location-state.js";
import { createStorageClient } from "../modules/storage/storage.js";
import { handleRuntimeMessage } from "../background/service-worker.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const SAMPLE_LOCATIONS = [
  { locationName: "Sydney", latitude: -33.8688, longitude: 151.2093, country: "Australia", language: "en-AU" },
  { locationName: "London", latitude: 51.5074, longitude: -0.1278, country: "United Kingdom", language: "en-GB" },
  { locationName: "New York", latitude: 40.7128, longitude: -74.006, country: "United States", language: "en-US" },
  { locationName: "Delhi", latitude: 28.6139, longitude: 77.209, country: "India", language: "en-IN" },
];

function createMockChrome({
  attachError = null,
  overrideError = null,
  probeOverride = null,
  initialTabs = [],
} = {}) {
  const store = new Map();
  const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
  let nextTabId = 100;
  const attachedTabs = new Set();
  const commandsSent = [];
  const detachedCalls = [];

  return {
    _tabs: tabs,
    _attachedTabs: attachedTabs,
    _commandsSent: commandsSent,
    _detachedCalls: detachedCalls,
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
      onUpdated: {
        addListener() {},
        removeListener() {},
      },
      async get(tabId) {
        if (!tabs.has(tabId)) {
          throw new Error(`No tab with id: ${tabId}`);
        }
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
        if (attachError) throw new Error(attachError);
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        attachedTabs.add(tabId);
      },
      async detach({ tabId }) {
        detachedCalls.push(tabId);
        attachedTabs.delete(tabId);
      },
      async sendCommand({ tabId }, method, params) {
        commandsSent.push({ tabId, method, params });
        if (!attachedTabs.has(tabId)) {
          throw new Error("Debugger is not attached to the tab with id: " + tabId);
        }
        if (method === "Emulation.setGeolocationOverride") {
          if (overrideError) throw new Error(overrideError);
          tabs.get(tabId)._geo = { ...params };
          return {};
        }
        if (method === "Emulation.clearGeolocationOverride") {
          delete tabs.get(tabId)._geo;
          return {};
        }
        if (method === "Runtime.evaluate") {
          if (probeOverride) {
            return { result: { value: probeOverride(tabs.get(tabId)._geo) } };
          }
          const geo = tabs.get(tabId)._geo;
          return {
            result: {
              value: {
                ok: true,
                permissionStatus: "granted",
                latitude: geo.latitude,
                longitude: geo.longitude,
                accuracy: geo.accuracy,
              },
            },
          };
        }
        return {};
      },
    },
  };
}

test("validates valid, negative, and >90m accuracy coordinates", () => {
  for (const loc of SAMPLE_LOCATIONS) {
    const res = validateLocationInput({ ...loc, accuracy: 150 });
    assert.equal(res.valid, true);
    assert.equal(res.value.latitude, loc.latitude);
    assert.equal(res.value.longitude, loc.longitude);
    assert.equal(res.value.accuracy, 150);
  }

  const defaults = validateLocationInput({ latitude: 0, longitude: 0 });
  assert.equal(defaults.valid, true);
  assert.equal(defaults.value.accuracy, DEFAULT_ACCURACY_METRES);
});

test("rejects blank, out-of-range, and non-finite coordinates", () => {
  assert.equal(validateLocationInput({ latitude: "", longitude: 151.2 }).valid, false);
  assert.equal(validateLocationInput({ latitude: 91, longitude: 0 }).valid, false);
  assert.equal(validateLocationInput({ latitude: -91, longitude: 0 }).valid, false);
  assert.equal(validateLocationInput({ latitude: 0, longitude: 181 }).valid, false);
  assert.equal(validateLocationInput({ latitude: 0, longitude: -181 }).valid, false);
  assert.equal(validateLocationInput({ latitude: -33.8, longitude: 151.2, accuracy: 0 }).valid, false);
  assert.equal(validateLocationInput({ latitude: -33.8, longitude: 151.2, accuracy: -5 }).valid, false);
  assert.equal(validateLocationInput({ latitude: NaN, longitude: Infinity }).valid, false);
  assert.equal(
    validateLocationInput({ latitude: -33.8, longitude: 151.2, testPageUrl: "javascript:alert(1)" }).valid,
    false
  );
});

test("parses pasted coordinate pairs cleanly", () => {
  const sydney = parseCoordinatePair("-33.8688, 151.2093");
  assert.equal(sydney.valid, true);
  assert.equal(sydney.latitude, -33.8688);
  assert.equal(sydney.longitude, 151.2093);

  const london = parseCoordinatePair("51.5074,-0.1278");
  assert.equal(london.valid, true);
  assert.equal(london.latitude, 51.5074);
  assert.equal(london.longitude, -0.1278);

  assert.equal(parseCoordinatePair("").valid, false);
  assert.equal(parseCoordinatePair("95, 151").valid, false);
  assert.equal(parseCoordinatePair("not-a-coord").valid, false);
});

test("applies and verifies all 4 sample locations on a dedicated tab without touching unrelated tabs", async () => {
  const mockChrome = createMockChrome({
    initialTabs: [{ id: 1, url: "https://unrelated.example.org/", status: "complete" }],
  });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  for (const sample of SAMPLE_LOCATIONS) {
    const res = await controller.applyLocation({ ...sample, accuracy: 120 });
    assert.equal(res.ok, true);
    assert.equal(res.state.state, LOCATION_STATES.GPS_VERIFIED);
    assert.equal(res.state.debuggerAttached, true);
    assert.equal(res.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.UNVERIFIED);
    assert.ok(Math.abs(res.state.reportedCoords.latitude - sample.latitude) <= DEFAULT_COORDINATE_TOLERANCE_DEGREES);
    assert.ok(Math.abs(res.state.reportedCoords.longitude - sample.longitude) <= DEFAULT_COORDINATE_TOLERANCE_DEGREES);
    assert.equal(res.state.reportedCoords.accuracy, 120);
    assert.notEqual(res.state.tabId, 1);
  }

  // Unrelated tab 1 was never attached or modified
  assert.equal(mockChrome._attachedTabs.has(1), false);
  assert.equal(mockChrome._tabs.get(1)._geo, undefined);
});

test("handles failed debugger attachment safely", async () => {
  const mockChrome = createMockChrome({ attachError: "Another debugger is already attached" });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const res = await controller.applyLocation({ latitude: -33.8688, longitude: 151.2093 });
  assert.equal(res.ok, false);
  assert.equal(res.state.state, LOCATION_STATES.VERIFICATION_FAILED);
  assert.equal(res.state.debuggerAttached, false);
  assert.match(res.error, /Another debugger is already attached/);
});

test("detects coordinate mismatch when browser reports different coordinates", async () => {
  const mockChrome = createMockChrome({
    probeOverride: () => ({
      ok: true,
      permissionStatus: "granted",
      latitude: 0,
      longitude: 0,
      accuracy: 20,
    }),
  });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const res = await controller.applyLocation({ latitude: 51.5074, longitude: -0.1278 });
  assert.equal(res.ok, false);
  assert.equal(res.state.state, LOCATION_STATES.LOCATION_MISMATCH);
  assert.equal(res.state.googleLocationStatus, GOOGLE_LOCATION_STATUSES.UNVERIFIED);
});

test("detects location permission denial", async () => {
  const mockChrome = createMockChrome({
    probeOverride: () => ({
      ok: false,
      code: "PERMISSION_DENIED",
      permissionStatus: "denied",
      error: "User denied Geolocation",
    }),
  });
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const res = await controller.applyLocation({ latitude: 40.7128, longitude: -74.006 });
  assert.equal(res.ok, false);
  assert.equal(res.state.state, LOCATION_STATES.PERMISSION_DENIED);
  assert.equal(res.state.permissionStatus, "denied");
});

test("detects debugger detachment, tab closure, and revalidates session on reload", async () => {
  const mockChrome = createMockChrome();
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const applied = await controller.applyLocation({
    locationName: "Delhi",
    latitude: 28.6139,
    longitude: 77.209,
  });
  assert.equal(applied.ok, true);
  const tabId = applied.state.tabId;

  // Simulate debugger detachment event
  const afterDetach = await controller.handleDebuggerDetached({ tabId, reason: "canceled_by_user" });
  assert.equal(afterDetach.state, LOCATION_STATES.DEBUGGER_DETACHED);
  assert.equal(afterDetach.debuggerAttached, false);

  // Re-apply then simulate unexpected target drop (e.g., browser/SW restart) without event
  await controller.applyLocation({ latitude: 28.6139, longitude: 77.209 });
  mockChrome._attachedTabs.delete(tabId);
  const revalidatedAfterDrop = await controller.getStatus();
  assert.equal(revalidatedAfterDrop.state, LOCATION_STATES.DEBUGGER_DETACHED);
  assert.equal(revalidatedAfterDrop.debuggerAttached, false);

  // Re-apply then simulate tab closure via event and via missing tab during revalidation
  await controller.applyLocation({ latitude: 28.6139, longitude: 77.209 });
  mockChrome._tabs.delete(tabId);
  const afterClose = await controller.handleTabRemoved({ tabId });
  assert.equal(afterClose.tabId, null);
  assert.equal(afterClose.debuggerAttached, false);
  assert.equal(afterClose.state, LOCATION_STATES.DEBUGGER_DETACHED);
});

test("resets location cleanly, clears override, detaches debugger, and preserves config", async () => {
  const mockChrome = createMockChrome();
  const storage = createStorageClient(mockChrome.storage.local);
  const controller = createGeolocationController({ chromeApi: mockChrome, storageClient: storage });

  const applied = await controller.applyLocation({
    locationName: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
  });
  const tabId = applied.state.tabId;

  const resetRes = await controller.resetLocation();
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.state.state, LOCATION_STATES.CONFIGURED);
  assert.equal(resetRes.state.debuggerAttached, false);
  assert.equal(resetRes.state.tabId, null);
  assert.equal(resetRes.state.reportedCoords, null);
  assert.equal(resetRes.state.config.latitude, -33.8688);
  assert.ok(mockChrome._detachedCalls.includes(tabId));
  assert.equal(mockChrome._attachedTabs.has(tabId), false);
});

test("service worker routes Phase 2 location messages cleanly", async () => {
  const mockChrome = createMockChrome();

  const applyMsg = await handleRuntimeMessage(
    {
      type: MESSAGE_TYPES.LOCATION_APPLY,
      payload: {
        locationName: "London",
        latitude: 51.5074,
        longitude: -0.1278,
        accuracy: 20,
      },
    },
    null,
    mockChrome
  );
  assert.equal(applyMsg.ok, true);
  assert.equal(applyMsg.state.state, LOCATION_STATES.GPS_VERIFIED);

  const testMsg = await handleRuntimeMessage({ type: MESSAGE_TYPES.LOCATION_TEST }, null, mockChrome);
  assert.equal(testMsg.ok, true);

  const statusMsg = await handleRuntimeMessage({ type: MESSAGE_TYPES.LOCATION_GET_STATUS }, null, mockChrome);
  assert.equal(statusMsg.ok, true);
  assert.equal(statusMsg.state.state, LOCATION_STATES.GPS_VERIFIED);

  const resetMsg = await handleRuntimeMessage({ type: MESSAGE_TYPES.LOCATION_RESET }, null, mockChrome);
  assert.equal(resetMsg.ok, true);
  assert.equal(resetMsg.state.debuggerAttached, false);
});

