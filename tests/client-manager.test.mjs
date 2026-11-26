import assert from "node:assert/strict";
import test from "node:test";
import { exportClientConfiguration, importClientConfiguration } from "../modules/clients/client-import-export.js";
import { computeClientOverview, createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";

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

async function setupClientDeps() {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });
  const clientManager = createClientManager({
    clientStorage,
    locationManager,
    keywordManager,
  });
  return { clientStorage, locationManager, keywordManager, clientManager };
}

test("client CRUD, duplicate names, archiving, duplicating, searching, and confirmed deletion", async () => {
  const { clientManager, locationManager, keywordManager } = await setupClientDeps();

  const c1 = await clientManager.createClient({
    clientName: "Apex Services",
    websiteDomain: "https://www.apexservices.com.au/path",
    sheetConfig: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0",
      worksheetName: "Rankings",
    },
  });
  assert.equal(c1.ok, true);
  assert.equal(c1.client.websiteDomain, "apexservices.com.au");
  assert.equal(c1.client.sheetConfig.spreadsheetId, "1AbCdEfGhIjKlMnOpQrStUvWxYz");

  // Duplicate display name must still succeed with distinct ID
  const c2 = await clientManager.createClient({
    clientName: "Apex Services",
    websiteDomain: "apex-nz.co.nz",
  });
  assert.equal(c2.ok, true);
  assert.notEqual(c2.client.clientId, c1.client.clientId);

  await locationManager.addLocation({
    clientId: c1.client.clientId,
    locationName: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    country: "Australia",
  });
  await keywordManager.importFromText({
    clientId: c1.client.clientId,
    rawText: "emergency plumber sydney\nblocked drains",
  });

  const dup = await clientManager.duplicateClient(c1.client.clientId);
  assert.equal(dup.ok, true);
  assert.match(dup.client.clientName, /Copy/);
  assert.equal((await locationManager.listLocations(dup.client.clientId)).length, 1);
  assert.equal((await keywordManager.listKeywords(dup.client.clientId)).length, 2);

  await clientManager.archiveClient(c2.client.clientId);
  const nonArchived = await clientManager.searchClients({ includeArchived: false });
  assert.ok(!nonArchived.some((c) => c.clientId === c2.client.clientId));

  // Unconfirmed delete rejected
  const unconfirmed = await clientManager.deleteClient(c2.client.clientId, { confirmed: false });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.requiresConfirmation, true);

  const confirmed = await clientManager.deleteClient(c2.client.clientId, { confirmed: true });
  assert.equal(confirmed.ok, true);
});

test("location validation rejects bad coordinates and detects sheet worksheet/column collisions", async () => {
  const { clientManager, locationManager } = await setupClientDeps();
  const c1 = await clientManager.createClient({
    clientName: "Collision Test",
    websiteDomain: "collision.example.com",
  });

  const invalidCoord = await locationManager.addLocation({
    clientId: c1.client.clientId,
    locationName: "Invalid",
    latitude: 120,
    longitude: 151,
  });
  assert.equal(invalidCoord.ok, false);

  const locA = await locationManager.addLocation({
    clientId: c1.client.clientId,
    locationName: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    worksheetName: "AU",
    reportingRange: "H",
  });
  assert.equal(locA.ok, true);

  const locCollision = await locationManager.addLocation({
    clientId: c1.client.clientId,
    locationName: "Melbourne",
    latitude: -37.8136,
    longitude: 144.9631,
    worksheetName: "AU",
    reportingRange: "H",
  });
  assert.equal(locCollision.ok, false);
  assert.match(locCollision.errors[0], /overlap on worksheet|share the same target sheet range/i);
});

test("keyword manager preserves duplicate keywords from paste/CSV and exports/imports client JSON", async () => {
  const { clientManager, locationManager, keywordManager } = await setupClientDeps();
  const c1 = await clientManager.createClient({
    clientName: "Keyword Co",
    websiteDomain: "keywordco.com",
  });

  const pasteRes = await keywordManager.importFromText({
    clientId: c1.client.clientId,
    rawText: "seo agency\nseo agency\nseo consultant",
  });
  assert.equal(pasteRes.ok, true);
  assert.equal(pasteRes.added.length, 3);

  const csvRes = await keywordManager.importFromCsv({
    clientId: c1.client.clientId,
    csvText: "keyword,group,row,landing_page,volume,competition\nlocal seo,Core,15,/local-seo,480,Medium",
  });
  assert.equal(csvRes.ok, true);
  assert.equal(csvRes.added[0].rowPosition, 15);
  assert.equal(csvRes.added[0].landingPage, "/local-seo");

  const ws = await clientManager.getClientWorkspace(c1.client.clientId);
  assert.equal(ws.overview.hasRankingData, false);
  assert.equal(ws.overview.top3Count, null);

  const json = exportClientConfiguration({
    client: ws.client,
    locations: ws.locations,
    keywords: ws.keywords,
  });
  const imported = await importClientConfiguration(json, {
    clientManager,
    locationManager,
    keywordManager,
  });
  assert.equal(imported.ok, true);
  assert.equal((await keywordManager.listKeywords(imported.client.clientId)).length, 4);

  const withResults = computeClientOverview({
    client: ws.client,
    locations: ws.locations,
    keywords: ws.keywords,
    results: [
      { status: TASK_STATUSES.RANKED, position: 2 },
      { status: TASK_STATUSES.RANKED, position: 9 },
      { status: TASK_STATUSES.RANKED, position: 15 },
      { status: TASK_STATUSES.NOT_FOUND, position: null },
    ],
  });
  assert.equal(withResults.hasRankingData, true);
  assert.equal(withResults.top3Count, 1);
  assert.equal(withResults.top10Count, 2);
  assert.equal(withResults.top20Count, 3);
});
