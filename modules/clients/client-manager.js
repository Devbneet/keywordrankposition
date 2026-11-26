/**
 * Centralized Multi-Client Manager handling CRUD, archiving, duplication,
 * search, client switching with location/job safety, and overview metrics.
 */

import { TASK_STATUSES } from "../jobs/job-state.js";
import { validateCrossClientSheetConfigurations } from "../sheets/sheet-range-validator.js";
import { validateClientInput } from "./client-validator.js";

export function computeClientOverview({
  client,
  locations = [],
  keywords = [],
  jobs = [],
  results = [],
}) {
  const rankedResults = results.filter(
    (r) => r.status === TASK_STATUSES.RANKED && typeof r.position === "number"
  );
  const hasRankingData = results.length > 0;
  const latestJob = jobs[0] || null;
  const sheetConfigured = Boolean(client?.sheetConfig?.spreadsheetId);

  return {
    clientId: client.clientId,
    clientName: client.clientName,
    websiteDomain: client.websiteDomain,
    status: client.status,
    keywordCount: keywords.length,
    locationCount: locations.length,
    locationNames: locations.map((l) => l.locationName).filter(Boolean),
    lastRankingCheck: client.lastCheckedAt || latestJob?.completedAt || latestJob?.createdAt || null,
    hasRankingData,
    top3Count: hasRankingData ? rankedResults.filter((r) => r.position <= 3).length : null,
    top10Count: hasRankingData ? rankedResults.filter((r) => r.position <= 10).length : null,
    top20Count: hasRankingData ? rankedResults.filter((r) => r.position <= 20).length : null,
    lastJobStatus: latestJob?.state || "No data",
    sheetConfigStatus: sheetConfigured ? "Configured" : "Not configured",
  };
}

export function createClientManager({
  clientStorage,
  locationManager,
  keywordManager,
  locationController = null,
  jobManager = null,
}) {
  async function checkCrossClientCollisions(candidateClient) {
    if (!candidateClient?.sheetConfig?.spreadsheetId) {
      return { valid: true, collisions: [] };
    }
    const existingClients = await clientStorage.listClients();
    const others = existingClients.filter((c) => c.clientId !== candidateClient.clientId);
    const allClients = [...others, candidateClient];
    const locationsByClient = {};
    for (const c of allClients) {
      locationsByClient[c.clientId] = await locationManager.listLocations(c.clientId);
    }
    return validateCrossClientSheetConfigurations({ clients: allClients, locationsByClient });
  }

  async function createClient(input) {
    const validated = validateClientInput(input);
    if (!validated.valid) {
      return { ok: false, errors: validated.errors };
    }

    const existing = await clientStorage.getClient(validated.value.clientId);
    if (existing) {
      return { ok: false, error: `Client ID '${validated.value.clientId}' already exists.` };
    }

    const now = new Date().toISOString();
    const record = {
      ...validated.value,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
    };

    const crossCheck = await checkCrossClientCollisions(record);
    if (!crossCheck.valid) {
      return { ok: false, errors: crossCheck.collisions };
    }

    const saveRes = await clientStorage.saveClient(record);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error, quotaExceeded: saveRes.quotaExceeded };
    }
    return { ok: true, client: record };
  }

  async function updateClient(clientId, updates = {}) {
    const existing = await clientStorage.getClient(clientId);
    if (!existing) {
      return { ok: false, error: `Client '${clientId}' not found.` };
    }

    const validated = validateClientInput({
      ...existing,
      ...updates,
      clientId,
      sheetConfig: {
        ...(existing.sheetConfig || {}),
        ...(updates.sheetConfig || {}),
      },
    });
    if (!validated.valid) {
      return { ok: false, errors: validated.errors };
    }

    const updated = {
      ...existing,
      ...validated.value,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const crossCheck = await checkCrossClientCollisions(updated);
    if (!crossCheck.valid) {
      return { ok: false, errors: crossCheck.collisions };
    }

    const saveRes = await clientStorage.saveClient(updated);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error, quotaExceeded: saveRes.quotaExceeded };
    }
    return { ok: true, client: updated };
  }

  async function archiveClient(clientId) {
    return updateClient(clientId, { status: "archived" });
  }

  async function duplicateClient(clientId) {
    const source = await clientStorage.getClient(clientId);
    if (!source) {
      return { ok: false, error: `Client '${clientId}' not found.` };
    }

    const created = await createClient({
      clientName: `${source.clientName} (Copy)`,
      websiteDomain: source.websiteDomain,
      websiteUrl: source.websiteUrl,
      status: source.status === "archived" ? "inactive" : source.status,
      notes: source.notes,
      sheetConfig: {
        ...(source.sheetConfig || {}),
        sheetUrl: "",
        spreadsheetId: "",
        worksheetId: "",
      },
    });
    if (!created.ok) return created;

    const newClientId = created.client.clientId;
    const locations = await locationManager.listLocations(clientId);
    const locMap = new Map();

    for (const loc of locations) {
      const copyLoc = await locationManager.addLocation({
        ...loc,
        locationId: undefined,
        clientId: newClientId,
      });
      if (copyLoc.ok) {
        locMap.set(loc.locationId, copyLoc.location.locationId);
      }
    }

    const keywords = await keywordManager.listKeywords(clientId);
    if (keywords.length > 0) {
      await keywordManager.addKeywords({
        clientId: newClientId,
        items: keywords.map((kw) => ({
          ...kw,
          keywordId: undefined,
          locationId: kw.locationId ? locMap.get(kw.locationId) || null : null,
        })),
      });
    }

    return { ok: true, client: created.client };
  }

  async function deleteClient(clientId, { confirmed = false } = {}) {
    if (!confirmed) {
      return {
        ok: false,
        requiresConfirmation: true,
        error: "Confirmation is required before permanently deleting client data.",
      };
    }

    const active = await clientStorage.getActiveSelection();
    if (active?.clientId === clientId) {
      await clientStorage.setActiveSelection({ clientId: null, locationId: null });
    }
    return clientStorage.deleteClientCascade(clientId);
  }

  async function searchClients({ query = "", includeArchived = true } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const all = await clientStorage.listClients();
    return all.filter((c) => {
      if (!includeArchived && c.status === "archived") return false;
      if (!q) return true;
      return (
        c.clientName.toLowerCase().includes(q) ||
        c.websiteDomain.toLowerCase().includes(q) ||
        c.clientId.toLowerCase().includes(q)
      );
    });
  }

  async function getClientWorkspace(clientId, { locationId = null } = {}) {
    const client = await clientStorage.getClient(clientId);
    if (!client) {
      return { ok: false, error: `Client '${clientId}' not found.` };
    }

    const locations = await locationManager.listLocations(clientId);
    const keywords = await keywordManager.listKeywords(clientId);
    const jobs = await clientStorage.listJobsByClient(clientId);
    const results = await clientStorage.listResultsByClient(clientId);
    const selectedLocation =
      (locationId && locations.find((l) => l.locationId === locationId)) || locations[0] || null;

    return {
      ok: true,
      client,
      locations,
      selectedLocation,
      keywords,
      jobs,
      results,
      overview: computeClientOverview({ client, locations, keywords, jobs, results }),
    };
  }

  /**
   * Safely switch active client/location:
   * 1. Stop or pause any active bulk job.
   * 2. Reset/invalidate previous browser geolocation override.
   * 3. Persist new selection and return isolated client workspace.
   */
  async function selectClient({ clientId, locationId = null } = {}) {
    const workspace = await getClientWorkspace(clientId, { locationId });
    if (!workspace.ok) {
      return workspace;
    }

    if (jobManager) {
      const status = await jobManager.getStatus();
      if (status?.isBusy) {
        await jobManager.pauseJob();
      }
    }

    if (locationController) {
      await locationController.resetLocation();
    }

    const targetLocId = workspace.selectedLocation?.locationId || null;
    const selRes = await clientStorage.setActiveSelection({
      clientId,
      locationId: targetLocId,
    });
    if (!selRes.ok) {
      return selRes;
    }

    return {
      ...workspace,
      locationResetRequiredVerification: true,
    };
  }

  async function listClientOverviews({ query = "", includeArchived = true } = {}) {
    const clients = await searchClients({ query, includeArchived });
    const overviews = [];
    for (const client of clients) {
      const locations = await locationManager.listLocations(client.clientId);
      const keywords = await keywordManager.listKeywords(client.clientId);
      const jobs = await clientStorage.listJobsByClient(client.clientId);
      const results = await clientStorage.listResultsByClient(client.clientId);
      overviews.push(computeClientOverview({ client, locations, keywords, jobs, results }));
    }
    return overviews;
  }

  async function recordClientJobOutcome({ clientId, job, tasks }) {
    if (!clientId || !job) return { ok: true };
    const jobRes = await clientStorage.saveJobRecord({ ...job, clientId });
    if (!jobRes.ok) return jobRes;

    if (Array.isArray(tasks) && tasks.length > 0) {
      const resSave = await clientStorage.saveResultsBatch(
        tasks.map((t) => ({ ...t, clientId, locationId: job.locationId || null }))
      );
      if (!resSave.ok) return resSave;
    }

    const client = await clientStorage.getClient(clientId);
    if (client) {
      await clientStorage.saveClient({
        ...client,
        lastCheckedAt: job.completedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { ok: true };
  }

  return {
    createClient,
    updateClient,
    archiveClient,
    duplicateClient,
    deleteClient,
    searchClients,
    getClientWorkspace,
    selectClient,
    listClientOverviews,
    recordClientJobOutcome,
  };
}

