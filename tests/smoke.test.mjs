import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStorageClient } from "../modules/storage/storage.js";
import { handleRuntimeMessage } from "../background/service-worker.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function createMockChromeApi() {
  const store = new Map();
  const createdTabs = [];

  return {
    _createdTabs: createdTabs,
    runtime: {
      getManifest() {
        return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
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
            store.set(k, v);
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
      async query() {
        return [];
      },
      async create(opts) {
        const tab = { id: createdTabs.length + 1, ...opts };
        createdTabs.push(tab);
        return tab;
      },
      async update(id, opts) {
        return { id, ...opts };
      },
    },
  };
}

test("manifest.json is valid Manifest V3 with minimum Phase 8 read-only permissions", () => {
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Digital Minds Rank Tracker");
  assert.deepEqual(manifest.permissions, ["storage", "tabs", "debugger", "identity"]);
  assert.deepEqual(manifest.host_permissions, ["https://sheets.googleapis.com/*"]);
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_popup, "popup/popup.html");

  for (const relPath of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, relPath)), `Missing file referenced in manifest: ${relPath}`);
  }
});

test("extension PNG icons have valid PNG signatures", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const size of [16, 32, 48, 128]) {
    const iconPath = path.join(ROOT, "icons", `icon${size}.png`);
    assert.ok(fs.existsSync(iconPath), `Missing icon${size}.png`);
    const bytes = fs.readFileSync(iconPath);
    assert.ok(bytes.subarray(0, 8).equals(pngHeader), `Invalid PNG signature in icon${size}.png`);
  }
});

test("SHEET_REQUIREMENTS.md is preserved", () => {
  const reqPath = path.join(ROOT, "SHEET_REQUIREMENTS.md");
  assert.ok(fs.existsSync(reqPath));
  const content = fs.readFileSync(reqPath, "utf8");
  assert.match(content, /Mandatory Preservation Rules/);
});

test("storage client performs read/write health ping", async () => {
  const mockChrome = createMockChromeApi();
  const storage = createStorageClient(mockChrome.storage.local);

  await storage.set({ sampleKey: "hello" });
  assert.deepEqual(await storage.get("sampleKey"), { sampleKey: "hello" });

  const ping = await storage.pingStorage();
  assert.equal(ping.ok, true);
  assert.ok(ping.checkedAt);

  await storage.remove("sampleKey");
  assert.deepEqual(await storage.get("sampleKey"), {});
});

test("service worker handles HEALTH_CHECK, STORAGE_SELF_TEST, and OPEN_DASHBOARD", async () => {
  const mockChrome = createMockChromeApi();

  const health = await handleRuntimeMessage({ type: MESSAGE_TYPES.HEALTH_CHECK }, null, mockChrome);
  assert.equal(health.ok, true);
  assert.equal(health.status, "healthy");
  assert.equal(health.storageOk, true);
  assert.equal(health.version, "0.1.0");

  const storageRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.STORAGE_SELF_TEST }, null, mockChrome);
  assert.equal(storageRes.ok, true);

  const dashRes = await handleRuntimeMessage({ type: MESSAGE_TYPES.OPEN_DASHBOARD }, null, mockChrome);
  assert.equal(dashRes.ok, true);
  assert.equal(dashRes.reused, false);
  assert.equal(mockChrome._createdTabs.length, 1);
  assert.equal(mockChrome._createdTabs[0].url, "chrome-extension://test-id/dashboard/dashboard.html");
});

