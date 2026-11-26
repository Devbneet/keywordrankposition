/**
 * Google Sheets write operation journal, per-spreadsheet concurrency lock,
 * duplicate update protection, and lost/timed-out API response reconciliation.
 */

export const OPERATION_STATES = Object.freeze({
  READY: "Ready",
  AUTHENTICATION_REQUIRED: "Authentication required",
  READ_ONLY_ACCESS: "Read-only access",
  PREVIEW_GENERATED: "Preview generated",
  STRUCTURE_CHANGED: "Structure changed",
  BACKUP_REQUIRED: "Backup required",
  BACKUP_VERIFIED: "Backup verified",
  AWAITING_CONFIRMATION: "Awaiting confirmation",
  UPDATING: "Updating",
  VERIFICATION_IN_PROGRESS: "Verification in progress",
  UPDATE_SUCCESSFUL: "Update successful",
  UPDATE_FAILED: "Update failed",
  VERIFICATION_FAILED: "Verification failed",
  RECOVERY_REQUIRED: "Recovery required",
});

export function createUpdateJournal({ clientStorage }) {
  const spreadsheetLocks = new Map();

  function createOperationId(clientId = "cli") {
    return `op_${clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function acquireSpreadsheetLock(spreadsheetId, operationId) {
    if (spreadsheetLocks.has(spreadsheetId)) {
      return {
        acquired: false,
        holderOperationId: spreadsheetLocks.get(spreadsheetId),
        error: `Another update (${spreadsheetLocks.get(spreadsheetId)}) is already in progress for spreadsheet '${spreadsheetId}'. Wait for it to complete.`,
      };
    }
    spreadsheetLocks.set(spreadsheetId, operationId);
    return { acquired: true };
  }

  function releaseSpreadsheetLock(spreadsheetId, operationId) {
    if (spreadsheetLocks.get(spreadsheetId) === operationId) {
      spreadsheetLocks.delete(spreadsheetId);
    }
  }

  async function recordOperation(entry) {
    const now = new Date().toISOString();
    const fullEntry = {
      createdAt: entry.createdAt || now,
      updatedAt: now,
      ...entry,
    };
    if (clientStorage?.saveUpdateJournalEntry) {
      const res = await clientStorage.saveUpdateJournalEntry(fullEntry);
      if (!res.ok) return res;
    }
    return { ok: true, entry: fullEntry };
  }

  async function hasSuccessfulDuplicateUpdate({
    spreadsheetId,
    worksheetId,
    planFingerprint,
  }) {
    if (!clientStorage?.listUpdateJournalBySpreadsheet) {
      return { duplicate: false };
    }
    const entries = await clientStorage.listUpdateJournalBySpreadsheet(spreadsheetId);
    const match = entries.find(
      (e) =>
        e.spreadsheetId === spreadsheetId &&
        String(e.worksheetId) === String(worksheetId) &&
        e.planFingerprint === planFingerprint &&
        e.status === OPERATION_STATES.UPDATE_SUCCESSFUL
    );
    return match ? { duplicate: true, existingOperation: match } : { duplicate: false };
  }

  /**
   * Reconcile timed-out or lost API responses by re-reading the sheet instead
   * of blindly re-submitting a column insertion.
   */
  async function reconcileLostWriteResponse({
    sheetReader,
    operationEntry,
    plan,
  }) {
    const reread = await sheetReader.readAndAnalyzeSheet({
      clientId: operationEntry.clientId,
      locationId: plan.locationId,
      sheetUrlOrId: plan.spreadsheetId,
      worksheetId: plan.worksheetId,
      worksheetName: plan.worksheetName,
    });

    if (!reread.ok) {
      const failed = await recordOperation({
        ...operationEntry,
        status: OPERATION_STATES.RECOVERY_REQUIRED,
        verificationOutcome: { reconciled: false, error: reread.error },
      });
      return {
        applied: false,
        uncertain: true,
        status: OPERATION_STATES.RECOVERY_REQUIRED,
        entry: failed.entry,
        error: `Lost write response could not be reconciled via re-read (${reread.error}). Inspect sheet manually using backup '${operationEntry.backupId}'.`,
      };
    }

    const liveLatest = String(reread.structure.latestDateHeader || "").trim().toLowerCase();
    const targetLatest = String(plan.targetDateLabel || "").trim().toLowerCase();
    const dateApplied = liveLatest === targetLatest;

    const liveByRow = new Map((reread.structure.keywordRows || []).map((r) => [r.rowNumber, r]));
    let valuesMatch = true;
    for (const upd of plan.rankUpdates || []) {
      const liveRow = liveByRow.get(upd.rowNumber);
      if (!liveRow || String(liveRow.latestRank) !== String(upd.newRank)) {
        valuesMatch = false;
        break;
      }
    }

    if (dateApplied && valuesMatch) {
      const saved = await recordOperation({
        ...operationEntry,
        status: OPERATION_STATES.UPDATE_SUCCESSFUL,
        verificationOutcome: {
          reconciled: true,
          note: "Lost API response reconciled via re-read: column header and all planned ranking values were already applied.",
        },
      });
      return {
        applied: true,
        reconciled: true,
        status: OPERATION_STATES.UPDATE_SUCCESSFUL,
        reread,
        entry: saved.entry,
      };
    }

    const nextStatus = dateApplied
      ? OPERATION_STATES.VERIFICATION_FAILED
      : OPERATION_STATES.UPDATE_FAILED;
    const saved = await recordOperation({
      ...operationEntry,
      status: nextStatus,
      verificationOutcome: {
        reconciled: true,
        dateApplied,
        valuesMatch,
        note: dateApplied
          ? "Date header exists on live sheet, but some planned ranking values were missing."
          : "Write request did not land on the live sheet; safe to preview again without creating duplicate columns.",
      },
    });
    return {
      applied: false,
      reconciled: true,
      dateApplied,
      status: nextStatus,
      reread,
      entry: saved.entry,
    };
  }

  return {
    createOperationId,
    acquireSpreadsheetLock,
    releaseSpreadsheetLock,
    recordOperation,
    hasSuccessfulDuplicateUpdate,
    reconcileLostWriteResponse,
  };
}

