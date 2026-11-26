/**
 * Safe JSON import/export for client profiles (excluding credentials/tokens).
 */

export function exportClientConfiguration({ client, locations = [], keywords = [] }) {
  if (!client) {
    throw new Error("Client record is required for export.");
  }

  const sanitizedPayload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    client: {
      clientId: client.clientId,
      clientName: client.clientName,
      websiteDomain: client.websiteDomain,
      websiteUrl: client.websiteUrl,
      status: client.status,
      notes: client.notes || "",
      sheetConfig: client.sheetConfig || {},
    },
    locations: locations.map((loc) => ({ ...loc })),
    keywords: keywords.map((kw) => ({ ...kw })),
  };

  return JSON.stringify(sanitizedPayload, null, 2);
}

export async function importClientConfiguration(
  rawJson,
  { clientManager, locationManager, keywordManager, preserveIds = false }
) {
  let parsed;
  try {
    parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch {
    return { ok: false, error: "Invalid JSON client configuration." };
  }

  const srcClient = parsed?.client;
  if (!srcClient || !srcClient.clientName) {
    return { ok: false, error: "Client configuration JSON is missing client details." };
  }

  const created = await clientManager.createClient({
    clientId: preserveIds ? srcClient.clientId : undefined,
    clientName: srcClient.clientName,
    websiteDomain: srcClient.websiteDomain,
    websiteUrl: srcClient.websiteUrl,
    status: srcClient.status || "active",
    notes: srcClient.notes || "",
    sheetConfig: srcClient.sheetConfig || {},
  });

  if (!created.ok) {
    return created;
  }

  const newClientId = created.client.clientId;
  const locationIdMap = new Map();

  for (const loc of parsed.locations || []) {
    const locRes = await locationManager.addLocation({
      ...loc,
      locationId: preserveIds ? loc.locationId : undefined,
      clientId: newClientId,
    });
    if (!locRes.ok) {
      return { ok: false, error: locRes.errors?.join(" ") || locRes.error, client: created.client };
    }
    if (loc.locationId) {
      locationIdMap.set(loc.locationId, locRes.location.locationId);
    }
  }

  const rawKeywords = parsed.keywords || [];
  if (rawKeywords.length > 0) {
    const mappedKeywords = rawKeywords.map((kw) => ({
      ...kw,
      keywordId: preserveIds ? kw.keywordId : undefined,
      locationId: kw.locationId ? locationIdMap.get(kw.locationId) || null : null,
    }));
    const kwRes = await keywordManager.addKeywords({
      clientId: newClientId,
      items: mappedKeywords,
    });
    if (!kwRes.ok) {
      return { ok: false, error: kwRes.error, client: created.client };
    }
  }

  return {
    ok: true,
    client: created.client,
  };
}

