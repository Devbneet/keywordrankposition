import assert from "node:assert/strict";
import test from "node:test";
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createJobManager } from "../modules/jobs/job-manager.js";
import { createJobStorage } from "../modules/jobs/job-storage.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { GOOGLE_LOCATION_STATUSES, LOCATION_STATES } from "../modules/location/location-state.js";
import { RANKING_STATUSES } from "../modules/ranking/ranking-state.js";
import { createSingleKeywordChecker } from "../modules/ranking/single-keyword-checker.js";

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

test("multi-client workflow across 5 agency clients isolates jobs, results, and resets location on switch", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });

  let resetCalls = 0;
  let pausedCalls = 0;
  let busyMock = true;

  const mockLocationController = {
    async resetLocation() {
      resetCalls += 1;
      return { ok: true };
    },
  };
  const mockJobManager = {
    async getStatus() {
      return { ok: true, isBusy: busyMock };
    },
    async pauseJob() {
      pausedCalls += 1;
      busyMock = false;
      return { ok: true };
    },
  };

  const clientManager = createClientManager({
    clientStorage,
    locationManager,
    keywordManager,
    locationController: mockLocationController,
    jobManager: mockJobManager,
  });

  const sampleClients = [
    { clientName: "Acme Plumbing", websiteDomain: "acmeplumbing.com.au", city: "Sydney", lat: -33.8688, lng: 151.2093 },
    { clientName: "Bella Dental", websiteDomain: "belladental.com.au", city: "Melbourne", lat: -37.8136, lng: 144.9631 },
    { clientName: "Summit Legal", websiteDomain: "summitlegal.com.au", city: "Brisbane", lat: -27.4698, lng: 153.0251 },
    { clientName: "PixelCraft Studio", websiteDomain: "pixelcraft.co", city: "Perth", lat: -31.9505, lng: 115.8605 },
    { clientName: "Northside Physio", websiteDomain: "northsidephysio.com.au", city: "Adelaide", lat: -34.9285, lng: 138.6007 },
  ];

  const created = [];
  for (const item of sampleClients) {
    const res = await clientManager.createClient({
      clientName: item.clientName,
      websiteDomain: item.websiteDomain,
    });
    assert.equal(res.ok, true);
    const loc = await locationManager.addLocation({
      clientId: res.client.clientId,
      locationName: item.city,
      latitude: item.lat,
      longitude: item.lng,
      country: "Australia",
    });
    assert.equal(loc.ok, true);
    await keywordManager.importFromText({
      clientId: res.client.clientId,
      rawText: `${item.city.toLowerCase()} service`,
    });
    created.push({ client: res.client, location: loc.location });
  }

  // Record a ranking outcome only for client 0
  await clientManager.recordClientJobOutcome({
    clientId: created[0].client.clientId,
    job: { jobId: "job_c0", state: "Completed", locationId: created[0].location.locationId },
    tasks: [
      {
        taskId: "task_c0_0",
        jobId: "job_c0",
        keyword: "sydney service",
        status: TASK_STATUSES.RANKED,
        position: 1,
      },
    ],
  });

  // Switch while busy=true -> pauses active job & resets location override
  const switchRes = await clientManager.selectClient({ clientId: created[1].client.clientId });
  assert.equal(switchRes.ok, true);
  assert.equal(switchRes.locationResetRequiredVerification, true);
  assert.equal(pausedCalls, 1);
  assert.equal(resetCalls, 1);

  const overviews = await clientManager.listClientOverviews();
  assert.equal(overviews.length, 5);
  const c0Overview = overviews.find((o) => o.clientId === created[0].client.clientId);
  const c1Overview = overviews.find((o) => o.clientId === created[1].client.clientId);
  assert.equal(c0Overview.hasRankingData, true);
  assert.equal(c0Overview.top3Count, 1);
  assert.equal(c1Overview.hasRankingData, false);
  assert.equal(c1Overview.top3Count, null);
});

test("Phase 6 regressions: busy polling skips recovery, concurrent jobs & single+bulk locks hold, unauthorized blocked", async () => {
  const storageArea = createInMemoryStorage();
  const jobStorage = createJobStorage({ storageClient: storageArea, idbFactory: null });
  const sharedSearchLock = { owner: null };

  let gateResolve;
  const firstRunGate = new Promise((resolve) => {
    gateResolve = resolve;
  });

  const locStatus = {
    state: LOCATION_STATES.GOOGLE_MATCHED,
    debuggerAttached: true,
    tabId: 101,
    browserGpsStatus: LOCATION_STATES.GPS_VERIFIED,
    googleLocationStatus: GOOGLE_LOCATION_STATUSES.MATCHED,
    config: {
      locationName: "Sydney",
      latitude: -33.8688,
      longitude: 151.2093,
      accuracy: 20,
      country: "Australia",
      language: "en",
      googleDomain: "google.com.au",
    },
    reportedGps: { latitude: -33.8688, longitude: 151.2093 },
    googleDetectedLocation: "Sydney NSW",
  };
  const mockLocationCtrl = {
    getStatus: async () => locStatus,
    reverifySession: async () => ({ ok: true, state: locStatus }),
  };

  let enteredCheck = false;
  let notifyCheckEntered;
  const checkEnteredPromise = new Promise((resolve) => {
    notifyCheckEntered = resolve;
  });

  const gatedRunnerChecker = {
    async checkRanking({ keyword, websiteDomain }) {
      enteredCheck = true;
      notifyCheckEntered();
      await firstRunGate;
      return {
        ok: true,
        result: {
          keyword,
          websiteDomain,
          status: RANKING_STATUSES.RANKED,
          position: 3,
          rankingUrl: "https://example.com/",
          checkedResults: 10,
          checkedPages: 1,
        },
      };
    },
  };

  const jobManager = createJobManager({
    jobStorage,
    locationController: mockLocationCtrl,
    singleKeywordChecker: gatedRunnerChecker,
    searchLock: sharedSearchLock,
  });

  const unauthRes = await jobManager.startJob({
    websiteDomain: "example.com",
    keywords: ["seo"],
    isAuthorized: false,
  });
  assert.equal(unauthRes.ok, false);
  assert.match(unauthRes.error, /authorized/i);

  const singleChecker = createSingleKeywordChecker({
    storageClient: storageArea,
    locationController: mockLocationCtrl,
    searchLock: sharedSearchLock,
  });

  const singleUnauth = await singleChecker.checkRanking({
    websiteDomain: "example.com",
    keyword: "seo",
    isAuthorized: false,
  });
  assert.equal(singleUnauth.ok, false);
  assert.match(singleUnauth.error, /authorized/i);

  const runPromise = jobManager.startJob({
    websiteDomain: "example.com",
    keywords: ["seo agency"],
    isAuthorized: true,
  });

  await checkEnteredPromise;
  assert.equal(enteredCheck, true);

  // Polling while busy MUST NOT report recovered:true or mutate state
  const pollStatus = await jobManager.getStatus();
  assert.equal(pollStatus.isBusy, true);
  assert.notEqual(pollStatus.recovered, true);

  // Concurrent bulk start rejected
  const secondStart = await jobManager.startJob({
    websiteDomain: "example.com",
    keywords: ["other"],
    isAuthorized: true,
  });
  assert.equal(secondStart.ok, false);
  assert.match(secondStart.error, /already running/i);

  // Simultaneous live single check rejected by shared searchLock
  const collidingSingle = await singleChecker.checkRanking({
    websiteDomain: "example.com",
    keyword: "seo agency",
    isAuthorized: true,
  });
  assert.equal(collidingSingle.ok, false);
  assert.match(collidingSingle.error, /while 'bulk' ranking check is running/i);

  gateResolve();
  const finished = await runPromise;
  assert.equal(finished.ok, true);
});
