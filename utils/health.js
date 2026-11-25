/**
 * Build a standardized extension health report.
 */
export function buildHealthReport({
  version,
  storageOk,
  checkedAt = new Date().toISOString(),
  notes = [],
}) {
  return {
    ok: Boolean(storageOk),
    status: storageOk ? "healthy" : "error",
    version: String(version || "0.0.0"),
    storageOk: Boolean(storageOk),
    checkedAt,
    notes,
  };
}

