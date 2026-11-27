/**
 * Mandatory pre-write recoverable Google Sheet backup manager.
 * Captures complete cell values, formulas, formatting, merges, protected ranges,
 * conditional formatting, filters, column widths, and row heights using supported
 * Sheets API v4 read operations—NOT a shallow values-only CSV export.
 */

import { STORES } from "../storage/migrations.js";
import { createDatabase } from "../storage/database.js";
import { createSheetSnapshot } from "./sheet-snapshot.js";
import { detectSheetStructure } from "./sheet-structure-detector.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

function computeIntegrityHash(obj) {
  const str = JSON.stringify(obj);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function hasSufficientRestorationEvidence(snapshotData) {
  if (!snapshotData?.sheetProperties || !snapshotData?.gridData) return false;
  const rows = snapshotData.gridData.rowData || [];
  const hasDisplay = Array.isArray(snapshotData.displayValues) && snapshotData.displayValues.length > 0;
  const hasFormula = Array.isArray(snapshotData.formulaValues) && snapshotData.formulaValues.length > 0;
  if (!hasDisplay || !hasFormula || snapshotData.displayValues.length !== snapshotData.formulaValues.length) {
    return false;
  }
  const hasFormattingEvidence = rows.some((r) =>
    (r.values || []).some((c) => Boolean(c?.effectiveFormat || c?.userEnteredFormat))
  );
  const hasDimensionEvidence =
    (snapshotData.gridData.columnMetadata || []).length > 0 ||
    (snapshotData.gridData.rowMetadata || []).length > 0 ||
    rows.length > 0;
  return hasFormattingEvidence && hasDimensionEvidence;
}

export function buildRestoreBatchUpdateRequests(backupRecord) {
  const snap = backupRecord?.snapshotData;
  const sheetId = Number(backupRecord?.worksheetId);
  if (!snap || !Number.isInteger(sheetId) || sheetId < 0) {
    throw new Error("Valid recoverable backup with snapshotData and numeric worksheetId is required.");
  }

  const requests = [];
  const rowCount = snap.displayValues?.length || 0;
  const colCount = Math.max(
    ...(snap.displayValues || [[]]).map((r) => r.length),
    ...(snap.formulaValues || [[]]).map((r) => r.length),
    1
  );

  // 1. Restore values, formulas, and user/effective cell formatting across exact captured range
  const gridRows = [];
  for (let r = 0; r < rowCount; r += 1) {
    const dispRow = snap.displayValues[r] || [];
    const formRow = snap.formulaValues[r] || [];
    const gridCellRow = snap.gridData?.rowData?.[r]?.values || [];
    const cellObjs = [];
    for (let c = 0; c < colCount; c += 1) {
      const fVal = formRow[c];
      const dVal = dispRow[c];
      const rawCell = gridCellRow[c];
      const cellFormat = rawCell?.userEnteredFormat || rawCell?.effectiveFormat || undefined;
      let userEnteredValue;
      if (rawCell && rawCell.userEnteredValue !== undefined) {
        // Preserve exact original cell type (leading-zero strings, numbers, booleans, formulas, or blank)
        userEnteredValue = structuredClone(rawCell.userEnteredValue);
      } else if (typeof fVal === "string" && fVal.startsWith("=")) {
        userEnteredValue = { formulaValue: fVal };
      } else if (typeof dVal === "number" && Number.isFinite(dVal)) {
        userEnteredValue = { numberValue: dVal };
      } else if (typeof dVal === "boolean") {
        userEnteredValue = { boolValue: dVal };
      } else if (dVal === "" || dVal === null || dVal === undefined) {
        userEnteredValue = {};
      } else {
        userEnteredValue = { stringValue: String(dVal) };
      }
      cellObjs.push({
        userEnteredValue,
        ...(cellFormat ? { userEnteredFormat: cellFormat } : {}),
      });
    }
    gridRows.push({ values: cellObjs });
  }

  requests.push({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: rowCount,
        startColumnIndex: 0,
        endColumnIndex: colCount,
      },
      rows: gridRows,
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // 2. Restore column widths & row heights
  (snap.gridData?.columnMetadata || []).forEach((meta, idx) => {
    if (meta?.pixelSize) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: idx, endIndex: idx + 1 },
          properties: { pixelSize: meta.pixelSize },
          fields: "pixelSize",
        },
      });
    }
  });
  (snap.gridData?.rowMetadata || []).forEach((meta, idx) => {
    if (meta?.pixelSize) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: idx, endIndex: idx + 1 },
          properties: { pixelSize: meta.pixelSize },
          fields: "pixelSize",
        },
      });
    }
  });

  // 3. Restore merges & basicFilter
  for (const m of snap.merges || []) {
    requests.push({
      mergeCells: {
        range: { ...m, sheetId },
        mergeType: "MERGE_ALL",
      },
    });
  }
  if (snap.basicFilter) {
    requests.push({
      setBasicFilter: {
        filter: {
          ...snap.basicFilter,
          range: { ...(snap.basicFilter.range || {}), sheetId },
        },
      },
    });
  }
  (snap.conditionalFormats || []).forEach((rule, index) => {
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ...rule,
          ranges: (rule.ranges || []).map((rng) => ({ ...rng, sheetId })),
        },
        index,
      },
    });
  });

  return requests;
}

export function createSheetBackupManager({
  sheetsApiClient,
  sheetsWriteClient = null,
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
    approvedPlanFingerprint = null,
    preWriteSnapshotFingerprint = null,
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

    const snapshotData = {
      sheetProperties: sheetMeta.properties,
      merges: gridSheet?.merges || sheetMeta.merges || [],
      protectedRanges: gridSheet?.protectedRanges || sheetMeta.protectedRanges || [],
      basicFilter: gridSheet?.basicFilter || sheetMeta.basicFilter || null,
      filterViews: gridSheet?.filterViews || sheetMeta.filterViews || [],
      conditionalFormats: gridSheet?.conditionalFormats || sheetMeta.conditionalFormats || [],
      gridData: gridSheet?.data?.[0] || null,
      displayValues,
      formulaValues,
    };

    if (!metaRes.data?.properties?.title || !hasSufficientRestorationEvidence(snapshotData)) {
      return {
        ok: false,
        verificationStatus: "FAILED",
        error:
          "Recoverable spreadsheet backup verification failed: insufficient formatting, grid metadata, or matched display/formula evidence.",
      };
    }

    const contentIntegrityHash = computeIntegrityHash(snapshotData);
    let computedPreWriteFingerprint = preWriteSnapshotFingerprint;
    if (!computedPreWriteFingerprint) {
      const detectedStruct = detectSheetStructure({
        spreadsheetId,
        spreadsheetTitle: metaRes.data?.properties?.title || "",
        worksheetId: normalizeWorksheetId(sheetMeta.properties.sheetId),
        worksheetName: title,
        locale: metaRes.data?.properties?.locale || "",
        timeZone: metaRes.data?.properties?.timeZone || "",
        displayRows: displayValues,
        formulaRows: formulaValues,
        merges: snapshotData.merges,
        protectedRanges: snapshotData.protectedRanges,
        hasFilter: Boolean(
          snapshotData.basicFilter || (snapshotData.filterViews || []).length > 0
        ),
        basicFilter: snapshotData.basicFilter,
        filterViewsCount: (snapshotData.filterViews || []).length,
        conditionalFormats: snapshotData.conditionalFormats,
        gridSheet,
      });
      computedPreWriteFingerprint = createSheetSnapshot({
        clientId,
        structure: detectedStruct,
      }).structureFingerprint;
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
      approvedPlanFingerprint,
      preWriteSnapshotFingerprint: computedPreWriteFingerprint,
      contentIntegrityHash,
      createdAt: new Date().toISOString(),
      verificationStatus: "VERIFIED",
      locale: metaRes.data?.properties?.locale || "",
      timeZone: metaRes.data?.properties?.timeZone || "",
      restoreInstructions: [
        "1. Open the target Google Sheet and check Version History (File -> Version history) or use this verified extension snapshot.",
        "2. Do NOT overwrite collaborator edits automatically without reviewing row changes.",
        "3. Apply targeted restoration requests generated by buildRestoreBatchUpdateRequests if verification failed.",
      ],
      snapshotData,
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
      const readBack = await db.getByKey(STORES.BACKUPS, backupId);
      if (!readBack || readBack.contentIntegrityHash !== contentIntegrityHash) {
        return {
          ok: false,
          error: "Backup persistence read-back verification failed.",
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

  function verifyBackupIntegrity(
    backupRecord,
    expectedSpreadsheetId,
    expectedWorksheetId,
    {
      expectedClientId = null,
      expectedPlanFingerprint = null,
      expectedPreWriteFingerprint = null,
      requirePlanBinding = false,
      requirePreWriteBinding = true,
    } = {}
  ) {
    if (!backupRecord) {
      return { valid: false, error: "Mandatory verified backup is missing." };
    }
    if (backupRecord.verificationStatus !== "VERIFIED") {
      return { valid: false, error: `Backup '${backupRecord.backupId}' verification status is '${backupRecord.verificationStatus}'.` };
    }
    if (expectedClientId && backupRecord.clientId !== expectedClientId) {
      return { valid: false, error: `Backup belongs to client '${backupRecord.clientId}', expected '${expectedClientId}'.` };
    }
    if (backupRecord.spreadsheetId !== expectedSpreadsheetId) {
      return { valid: false, error: "Backup belongs to a different spreadsheet ID." };
    }
    if (normalizeWorksheetId(backupRecord.worksheetId) !== normalizeWorksheetId(expectedWorksheetId)) {
      return { valid: false, error: "Backup belongs to a different worksheet ID." };
    }
    if (requirePlanBinding || expectedPlanFingerprint) {
      if (!backupRecord.approvedPlanFingerprint) {
        return {
          valid: false,
          error: "Backup is missing mandatory approvedPlanFingerprint binding for the current update plan.",
        };
      }
      if (expectedPlanFingerprint && backupRecord.approvedPlanFingerprint !== expectedPlanFingerprint) {
        return { valid: false, error: "Backup does not match the currently approved update plan fingerprint." };
      }
    }
    if (requirePreWriteBinding || expectedPreWriteFingerprint) {
      if (!backupRecord.preWriteSnapshotFingerprint) {
        return {
          valid: false,
          error: "Backup is missing mandatory preWriteSnapshotFingerprint binding.",
        };
      }
      if (
        expectedPreWriteFingerprint &&
        backupRecord.preWriteSnapshotFingerprint !== expectedPreWriteFingerprint
      ) {
        return { valid: false, error: "Backup was captured against an outdated pre-write sheet structure." };
      }
    }
    if (!hasSufficientRestorationEvidence(backupRecord.snapshotData)) {
      return { valid: false, error: "Backup lacks full recoverable grid formatting and value/formula restoration evidence." };
    }
    if (!backupRecord.contentIntegrityHash) {
      return { valid: false, error: "Backup is missing mandatory contentIntegrityHash." };
    }
    const recomputedHash = computeIntegrityHash(backupRecord.snapshotData);
    if (backupRecord.contentIntegrityHash !== recomputedHash) {
      return { valid: false, error: "Backup content integrity check failed (hash mismatch / corrupted snapshot)." };
    }
    return { valid: true };
  }

  async function restoreFromBackup({
    backupRecord,
    writeClient = sheetsWriteClient,
    mode = "dry-run",
    dryRun = true,
    confirmedByUser = false,
  } = {}) {
    if (!backupRecord) {
      return { ok: false, error: "Backup record is required for restoration." };
    }
    const integrity = verifyBackupIntegrity(
      backupRecord,
      backupRecord.spreadsheetId,
      backupRecord.worksheetId,
      { expectedClientId: backupRecord.clientId }
    );
    if (!integrity.valid) {
      return { ok: false, error: integrity.error };
    }

    const requests = buildRestoreBatchUpdateRequests(backupRecord);
    if (dryRun || mode === "dry-run" || !confirmedByUser) {
      return {
        ok: true,
        dryRun: true,
        requestsCount: requests.length,
        requests,
        message: "Restoration plan verified (dry-run). Confirm explicitly to apply restore.",
      };
    }

    if (!writeClient) {
      return { ok: false, error: "sheetsWriteClient is required for live backup restoration." };
    }

    const writeRes = await writeClient.executeBatchUpdate({
      spreadsheetId: backupRecord.spreadsheetId,
      requests,
      mode,
      dryRun: false,
    });
    return writeRes;
  }

  return {
    createAndVerifyBackup,
    getBackup,
    listBackupsForClient,
    verifyBackupIntegrity,
    restoreFromBackup,
  };
}

