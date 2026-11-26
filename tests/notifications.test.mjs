import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNotificationContent,
  createNotificationManager,
  NOTIFICATION_EVENTS,
} from "../modules/notifications/notification-manager.js";
import { createScheduleStorage } from "../modules/scheduler/schedule-storage.js";

function createInMemoryStorage() {
  const map = new Map();
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

test("notificationManager builds accurate messages, invokes Chrome notifications API, and honors user preference toggles", async () => {
  const storageClient = createInMemoryStorage();
  const scheduleStorage = createScheduleStorage({ storageClient, idbFactory: null });
  const dispatched = [];
  const logs = [];

  const mgr = createNotificationManager({
    notificationsApi: {
      create(id, options, cb) {
        dispatched.push({ id, options });
        if (cb) cb(id);
      },
    },
    scheduleStorage,
    activityLogger: async (evt) => logs.push(evt),
  });

  // Event payload checks
  const capContent = buildNotificationContent(NOTIFICATION_EVENTS.CAPTCHA_BLOCKED, { scheduleName: "Apex Mon" });
  assert.match(capContent.title, /CAPTCHA/i);
  assert.match(capContent.message, /stopped safely/i);

  const compRes = await mgr.notify(NOTIFICATION_EVENTS.COMPLETED, {
    scheduleName: "Apex Mon",
    totalKeywords: 40,
    previewReady: true,
  });
  assert.equal(compRes.ok, true);
  assert.equal(compRes.delivered, true);
  assert.equal(dispatched.length, 1);
  assert.equal(logs.length, 1);

  // Suppress per-event notification when user toggles off
  await scheduleStorage.saveSchedulerSettings({
    notificationPreferences: { onCompleted: false },
  });
  const suppressed = await mgr.notify(NOTIFICATION_EVENTS.COMPLETED, { scheduleName: "Apex Mon" });
  assert.equal(suppressed.suppressed, true);
  assert.equal(dispatched.length, 1);

  // Disabled global toggle suppresses all notifications
  await scheduleStorage.saveSchedulerSettings({
    notificationPreferences: { enabled: false },
  });
  const globalSuppressed = await mgr.notify(NOTIFICATION_EVENTS.MISSED_RUN, { scheduleName: "Apex Mon" });
  assert.equal(globalSuppressed.suppressed, true);

  // Graceful behavior when chrome.notifications API is unavailable
  const fallbackMgr = createNotificationManager({ notificationsApi: null });
  const headless = await fallbackMgr.notify(NOTIFICATION_EVENTS.AUTH_REQUIRED, { scheduleName: "Apex" });
  assert.equal(headless.ok, true);
  assert.equal(headless.delivered, false);
});

