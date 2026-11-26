/**
 * Per-client location CRUD and sheet range collision validation.
 */

import {
  checkLocationSheetRangeCollisions,
  validateClientLocation,
} from "./client-validator.js";

export function createLocationManager({ clientStorage }) {
  async function listLocations(clientId) {
    return clientStorage.listLocationsByClient(clientId);
  }

  async function addLocation(input) {
    const validated = validateClientLocation(input);
    if (!validated.valid) {
      return { ok: false, errors: validated.errors };
    }

    const existing = await clientStorage.listLocationsByClient(validated.value.clientId);
    const client = await clientStorage.getClient(validated.value.clientId);
    const now = new Date().toISOString();
    const record = {
      ...validated.value,
      createdAt: now,
      updatedAt: now,
    };

    const collisionCheck = checkLocationSheetRangeCollisions({
      sheetConfig: client?.sheetConfig,
      locations: [...existing, record],
    });
    if (!collisionCheck.valid) {
      return { ok: false, errors: collisionCheck.collisions };
    }

    const saveRes = await clientStorage.saveLocation(record);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error, quotaExceeded: saveRes.quotaExceeded };
    }
    return { ok: true, location: record };
  }

  async function updateLocation(locationId, updates = {}) {
    const clientId = updates.clientId;
    if (!clientId) {
      return { ok: false, error: "clientId is required to update a location." };
    }
    const existingList = await clientStorage.listLocationsByClient(clientId);
    const existing = existingList.find((l) => l.locationId === locationId);
    if (!existing) {
      return { ok: false, error: `Location '${locationId}' not found.` };
    }

    const validated = validateClientLocation({ ...existing, ...updates, locationId, clientId });
    if (!validated.valid) {
      return { ok: false, errors: validated.errors };
    }

    const client = await clientStorage.getClient(clientId);
    const updatedRecord = {
      ...existing,
      ...validated.value,
      updatedAt: new Date().toISOString(),
    };

    const otherLocations = existingList.filter((l) => l.locationId !== locationId);
    const collisionCheck = checkLocationSheetRangeCollisions({
      sheetConfig: client?.sheetConfig,
      locations: [...otherLocations, updatedRecord],
    });
    if (!collisionCheck.valid) {
      return { ok: false, errors: collisionCheck.collisions };
    }

    const saveRes = await clientStorage.saveLocation(updatedRecord);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error, quotaExceeded: saveRes.quotaExceeded };
    }
    return { ok: true, location: updatedRecord };
  }

  async function deleteLocation(locationId) {
    return clientStorage.deleteLocation(locationId);
  }

  return {
    listLocations,
    addLocation,
    updateLocation,
    deleteLocation,
  };
}

