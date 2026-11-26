/**
 * Mandatory pre-write recoverable Google Sheet backup manager.
 * Captures complete cell values, formulas, formatting, merges, protected ranges,
 * conditional formatting, filters, column widths, and row heights using supported
 * Sheets API v4 read operations—NOT a shallow values-only CSV export.
 */

import { STORES } from "../storage/migrations.js";
import { createDatabase } from "../storage/database.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

export function createSheetBackupManager({
  sheetsApiClient,
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  const db = storageClient ? createDatabase({ storageClient, idbFactory }) : null;

  async function createAndVerifyBackup({
    clientId,
    spreadsheetId,
    worksheetId,
    worksheetName,
    jobId = null,
  } = {}) {
    if (!clientId || !spreadsheetId) {
      return { ok: false, error: "clientId and spreadsheetId are required to create a sheet backup." };
    }
    if (!sheetsApiClient) {
      return { ok: false, error: "sheetsApiClient is unavailable; cannot create backup." };
    }

    const wsIdStr = normalizeWorksheetId(worksheetId);
    const metaRes = await sheetsApiClient.getSpreadsheetMetadata(spreadsheetId);
    if (!metaRes.ok) {
      return { ok: false, error: `Backup failed reading metadata: ${metaRes.error}` };
    }

    const sheetMeta = (metaRes.data?.sheets || []).find(
      (s) =>
        (wsIdStr !== "" && normalizeWorksheetId(s.properties?.sheetId) === wsIdStr) ||
        (worksheetName && String(s.properties?.title || "").toLowerCase() === worksheetName.toLowerCase())
    );
    if (!sheetMeta) {
      return { ok: false, error: `Worksheet '${worksheetName || wsIdStr}' not found during backup.` };
    }

    const title = sheetMeta.properties.title;
    const escapedTitle = `'${title.replace(/'/g, "''")}'`;

    const [gridRes, dispRes, formRes] = await Promise.all([
      sheetsApiClient.getSpreadsheetGridDetails(spreadsheetId, [escapedTitle]),
      sheetsApiClient.batchGetValues(spreadsheetId, [escapedTitle], { valueRenderOption: "FORMATTED_VALUE" }),
      sheetsApiClient.batchGetValues(spreadsheetId, [escapedTitle], { valueRenderOption: "FORMULA" }),
    ]);

    if (!gridRes?.ok) {
      return { ok: false, error: `Complete grid formatting backup failed: ${gridRes?.error || "Unknown error"}` };
    }
    if (!dispRes?.ok || !formRes?.ok) {
      return { ok: false, error: "Backup failed capturing displayed/formula cell values." };
    }

    const gridSheet =
      (gridRes.data?.sheets || []).find(
        (s) => normalizeWorksheetId(s.properties?.sheetId) === normalizeWorksheetId(sheetMeta.properties.sheetId)
      ) || gridRes.data?.sheets?.[0];

    const displayValues = dispRes.data?.valueRanges?.[0]?.values || [];
    const formulaValues = formRes.data?.valueRanges?.[0]?.values || [];

    const hasMetadata = Boolean(metaRes.data?.properties?.title && sheetMeta.properties);
    const hasGridData = Boolean(gridSheet);
    const hasValues = displayValues.length > 0 && formulaValues.length > 0;

    if (!hasMetadata || !hasGridData || !hasValues) {
      return {
        ok: false,
        verificationStatus: "FAILED",
        error: "Recoverable spreadsheet backup verification failed: grid formatting, metadata, or values were incomplete.",
      };
    }

    const backupId = `sbkp_${clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      backupId,
      backupType: "google_sheet_full_recoverable",
      clientId,
      spreadsheetId,
      spreadsheetTitle: metaRes.data?.properties?.title || "",
      worksheetId: normalizeWorksheetId(sheetMeta.properties.sheetId),
      worksheetName: title,
      jobId,
      createdAt: new Date().toISOString(),
      verificationStatus: "VERIFIED",
      locale: metaRes.data?.properties?.locale || "",
      timeZone: metaRes.data?.properties?.timeZone || "",
      restoreInstructions: [
        "1. Open the target Google Sheet and check Version History (File -> Version history) or use this extension snapshot.",
        "2. Do NOT overwrite collaborator edits automatically without reviewing row changes.",
        "3. Apply targeted row/column restoration via the extension Recovery tool if verification failed.",
      ],
      snapshotData: {
        sheetProperties: sheetMeta.properties,
        merges: gridSheet.merges || sheetMeta.merges || [],
        protectedRanges: gridSheet.protectedRanges || sheetMeta.protectedRanges || [],
        basicFilter: gridSheet.basicFilter || sheetMeta.basicFilter || null,
        filterViews: gridSheet.filterViews || sheetMeta.filterViews || [],
        conditionalFormats: gridSheet.conditionalFormats || sheetMeta.conditionalFormats || [],
        gridData: gridSheet.data?.[0] || null,
        displayValues,
        formulaValues,
      },
    };

    if (db) {
      const saveRes = await db.putOne(STORES.BACKUPS, record);
      if (!saveRes.ok) {
        return {
          ok: false,
          quotaExceeded: saveRes.quotaExceeded,
          error: `Backup save failed: ${saveRes.error}`,
        };
      }
    }

    return { ok: true, backup: record };
  }

  async function getBackup(backupId) {
    if (!db || !backupId) return null;
    return db.getByKey(STORES.BACKUPS, backupId);
  }

  async function listBackupsForClient(clientId) {
    if (!db || !clientId) return [];
    const rows = await db.getByIndex(STORES.BACKUPS, "by_client", clientId);
    return rows
      .filter((r) => r.backupType === "google_sheet_full_recoverable")
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  function verifyBackupIntegrity(backupRecord, expectedSpreadsheetId, expectedWorksheetId) {
    if (!backupRecord) {
      return { valid: false, error: "Mandatory verified backup is missing." };
    }
    if (backupRecord.verificationStatus !== "VERIFIED") {
      return { valid: false, error: `Backup '${backupRecord.backupId}' verification status is '${backupRecord.verificationStatus}'.` };
    }
    if (backupRecord.spreadsheetId !== expectedSpreadsheetId) {
      return { valid: false, error: "Backup belongs to a different spreadsheet ID." };
    }
    if (normalizeWorksheetId(backupRecord.worksheetId) !== normalizeWorksheetId(expectedWorksheetId)) {
      return { valid: false, error: "Backup belongs to a different worksheet ID." };
    }
    if (!backupRecord.snapshotData?.formulaValues?.length || !backupRecord.snapshotData?.gridData) {
      return { valid: false, error: "Backup is missing full grid/formula state." };
    }
    return { valid: true };
  }

  return {
    createAndVerifyBackup,
    getBackup,
    listBackupsForClient,
    verifyBackupIntegrity,
  };
}

