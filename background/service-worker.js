import { createStorageClient, STORAGE_KEYS } from "../modules/storage/storage.js";
import { buildHealthReport } from "../utils/health.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

/**
 * Handle runtime messages from popup and dashboard pages.
 * Accepts an injectable chromeApi object so tests can run in Node.js without Chrome.
 */
export async function handleRuntimeMessage(message, _sender, chromeApi = globalThis.chrome) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message payload." };
  }

  const version = chromeApi?.runtime?.getManifest?.().version || "0.1.0";
  const storage = createStorageClient(chromeApi?.storage?.local);

  switch (message.type) {
    case MESSAGE_TYPES.HEALTH_CHECK: {
      const ping = await storage.pingStorage();
      return buildHealthReport({
        version,
        storageOk: ping.ok,
        checkedAt: ping.checkedAt,
        notes: ["Phase 1 core ready (background worker + chrome.storage.local)."],
      });
    }

    case MESSAGE_TYPES.STORAGE_SELF_TEST: {
      const ping = await storage.pingStorage();
      return {
        ok: ping.ok,
        checkedAt: ping.checkedAt,
      };
    }

    case MESSAGE_TYPES.OPEN_DASHBOARD: {
      const dashboardUrl = chromeApi.runtime.getURL("dashboard/dashboard.html");
      const existingTabs = await chromeApi.tabs.query({ url: dashboardUrl });
      if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
        await chromeApi.tabs.update(existingTabs[0].id, { active: true });
        return { ok: true, reused: true, tabId: existingTabs[0].id };
      }
      const created = await chromeApi.tabs.create({ url: dashboardUrl });
      return { ok: true, reused: false, tabId: created?.id ?? null };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    try {
      const storage = createStorageClient(chrome.storage.local);
      await storage.set({
        [STORAGE_KEYS.EXTENSION_META]: {
          installedAt: new Date().toISOString(),
          reason: details.reason,
          version: chrome.runtime.getManifest().version,
        },
      });
    } catch (error) {
      console.error("Failed to initialize extension metadata:", error);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleRuntimeMessage(message, sender, chrome)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });
}

