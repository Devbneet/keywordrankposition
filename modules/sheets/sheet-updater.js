/**
 * End-to-end Phase 9 Google Sheets Update Orchestrator:
 * Preview (dry-run) -> Verified Backup -> Pre-write Revalidation ->
 * Single Atomic BatchUpdate -> Journal / Timeout Reconciliation -> Post-update Verification.
 */

import { buildSheetUpdatePlan } from "./sheet-update-planner.js";
import { OPERATION_STATES } from "./update-journal.js";
import { approvePreviewPlan, buildDryRunPreview } from "./update-preview.js";
import { buildRecoveryPlan } from "./update-recovery.js";
import { verifyPostUpdateSpreadsheet } from "./update-verifier.js";

export function createSheetUpdater({
  authClient,
  sheetReader,
  sheetsApiClient,
  sheetsWriteClient,
  backupManager,
  updateJournal,
  clientStorage,
  locationManager,
} = {}) {
  async function loadClientContext(clientId) {
    const client = await clientStorage.getClient(clientId);
    if (!client) return { ok: false, error: `Client '${clientId}' not found.` };
    const allClients = await clientStorage.listClients();
    const locationsByClient = {};
    for (const c of allClients) {
      locationsByClient[c.clientId] = await locationManager.listLocations(c.clientId);
    }
    return { ok: true, client, allClients, locationsByClient };
  }

  async function readLiveValuesAndStructure({ clientId, locationId, client, sheetUrlOrId, worksheetId, worksheetName }) {
    const readRes = await sheetReader.readAndAnalyzeSheet({
      clientId,
      locationId,
      sheetUrlOrId: sheetUrlOrId || client.sheetConfig?.sheetUrl || client.sheetConfig?.spreadsheetId,
      worksheetId: worksheetId ?? client.sheetConfig?.worksheetId ?? "",
      worksheetName: worksheetName ?? client.sheetConfig?.worksheetName ?? "",
      columnConfig: client.sheetConfig || {},
    });
    if (!readRes.ok) return readRes;
    if (Array.isArray(readRes.displayRows)) {
      return readRes;
    }

    const escapedTitle = `'${readRes.worksheet.title.replace(/'/g, "''")}'`;
    const dispRes = await sheetsApiClient.batchGetValues(readRes.spreadsheetId, [escapedTitle], {
      valueRenderOption: "FORMATTED_VALUE",
    });
    const displayRows = dispRes.ok ? dispRes.data?.valueRanges?.[0]?.values || [] : [];
    return { ...readRes, displayRows };
  }

  async function generatePreview({
    clientId,
    locationId = null,
    job,
    tasks = [],
    reportingDate = new Date(),
    explicitHeaderLabel = "",
    backupId = null,
  } = {}) {
    const ctx = await loadClientContext(clientId);
    if (!ctx.ok) return { ...ctx, operationStatus: OPERATION_STATES.UPDATE_FAILED };

    const clientLocs = ctx.locationsByClient[clientId] || [];
    const location = (locationId && clientLocs.find((l) => l.locationId === locationId)) || clientLocs[0] || null;

    const live = await readLiveValuesAndStructure({
      clientId,
      locationId: location?.locationId || null,
      client: ctx.client,
    });
    if (!live.ok) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.UPDATE_FAILED,
        error: live.error,
      };
    }

    const snapshots = await clientStorage.listSheetSnapshotsByClient(clientId);
    const baselineSnapshot =
      snapshots.find(
        (s) => s.spreadsheetId === live.spreadsheetId && String(s.worksheetId) === String(live.worksheet.sheetId)
      ) || null;

    const planRes = buildSheetUpdatePlan({
      client: ctx.client,
      allClients: ctx.allClients,
      locationsByClient: ctx.locationsByClient,
      location,
      job,
      tasks,
      liveStructure: live.structure,
      displayRows: live.displayRows,
      baselineSnapshot,
      reportingDate,
      explicitHeaderLabel,
    });

    if (!planRes.ok) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.STRUCTURE_CHANGED,
        error: planRes.error,
        errors: planRes.errors,
        warnings: planRes.warnings,
      };
    }

    const backupRecord = backupId ? await backupManager.getBackup(backupId) : null;
    const preview = buildDryRunPreview({
      plan: planRes.plan,
      backupRecord,
      structureStatus: baselineSnapshot ? "Verified against import snapshot" : "Verified live",
    });

    return {
      ok: true,
      operationStatus: OPERATION_STATES.PREVIEW_GENERATED,
      preview,
      plan: planRes.plan,
      liveStructure: live.structure,
      liveDisplayRows: live.displayRows,
    };
  }

  async function executeApprovedUpdate({
    clientId,
    locationId = null,
    job,
    tasks = [],
    approvedPreview,
    approvalConfirmation = false,
    backupId,
    reportingDate = new Date(),
    explicitHeaderLabel = "",
    mode = "dry-run",
    dryRun = true,
  } = {}) {
    const authStatus = await authClient.getStatus();
    if (!authStatus.writeAccessEnabled && mode !== "dry-run") {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.READ_ONLY_ACCESS,
        error: "Spreadsheet Write Access is disabled. Enable Write Access before updating live spreadsheets.",
      };
    }

    const approval = approvePreviewPlan({ preview: approvedPreview, confirmedByUser: approvalConfirmation });
    if (!approval.ok) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.AWAITING_CONFIRMATION,
        error: approval.error,
      };
    }

    const ctx = await loadClientContext(clientId);
    if (!ctx.ok) return { ...ctx, operationStatus: OPERATION_STATES.UPDATE_FAILED };
    const clientLocs = ctx.locationsByClient[clientId] || [];
    const location = (locationId && clientLocs.find((l) => l.locationId === locationId)) || clientLocs[0] || null;

    // Step 1: Duplicate update guard against exact approved preview
    const dupPreCheck = await updateJournal.hasSuccessfulDuplicateUpdate({
      spreadsheetId: approvedPreview.spreadsheetId,
      worksheetId: approvedPreview.worksheetId,
      planFingerprint: approvedPreview.planFingerprint,
    });
    if (dupPreCheck.duplicate) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.UPDATE_SUCCESSFUL,
        duplicatePrevented: true,
        error: `Update plan (${approvedPreview.planFingerprint}) was already applied and verified in operation '${dupPreCheck.existingOperation.operationId}'.`,
      };
    }

    // Step 2: Mandatory verified backup check
    const backup = await backupManager.getBackup(backupId);
    const live = await readLiveValuesAndStructure({
      clientId,
      locationId: location?.locationId || null,
      client: ctx.client,
    });
    if (!live.ok) {
      return { ok: false, operationStatus: OPERATION_STATES.UPDATE_FAILED, error: live.error };
    }

    const backupCheck = backupManager.verifyBackupIntegrity(
      backup,
      live.spreadsheetId,
      live.worksheet.sheetId
    );
    if (!backupCheck.valid) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.BACKUP_REQUIRED,
        error: backupCheck.error,
      };
    }

    // Step 2: Revalidate live sheet & rebuild plan immediately before write, comparing planFingerprint!
    const snapshots = await clientStorage.listSheetSnapshotsByClient(clientId);
    const baselineSnapshot =
      snapshots.find(
        (s) => s.spreadsheetId === live.spreadsheetId && String(s.worksheetId) === String(live.worksheet.sheetId)
      ) || null;

    const freshPlanRes = buildSheetUpdatePlan({
      client: ctx.client,
      allClients: ctx.allClients,
      locationsByClient: ctx.locationsByClient,
      location,
      job,
      tasks,
      liveStructure: live.structure,
      displayRows: live.displayRows,
      baselineSnapshot,
      reportingDate,
      explicitHeaderLabel,
    });

    if (!freshPlanRes.ok) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.STRUCTURE_CHANGED,
        error: freshPlanRes.error,
        errors: freshPlanRes.errors,
      };
    }

    if (freshPlanRes.plan.planFingerprint !== approvedPreview.planFingerprint) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.STRUCTURE_CHANGED,
        approvalInvalidated: true,
        error:
          "Spreadsheet or ranking plan changed since the preview was approved. Generate and review a fresh preview before writing.",
      };
    }

    const plan = freshPlanRes.plan;

    // Step 3: Duplicate update guard
    const dupCheck = await updateJournal.hasSuccessfulDuplicateUpdate({
      spreadsheetId: plan.spreadsheetId,
      worksheetId: plan.worksheetId,
      planFingerprint: plan.planFingerprint,
    });
    if (dupCheck.duplicate) {
      return {
        ok: false,
        operationStatus: OPERATION_STATES.UPDATE_SUCCESSFUL,
        duplicatePrevented: true,
        error: `Update plan (${plan.planFingerprint}) was already applied and verified in operation '${dupCheck.existingOperation.operationId}'.`,
      };
    }

    // Step 4: Per-spreadsheet concurrency lock
    const operationId = updateJournal.createOperationId(clientId);
    const lock = updateJournal.acquireSpreadsheetLock(plan.spreadsheetId, operationId);
    if (!lock.acquired) {
      return { ok: false, operationStatus: OPERATION_STATES.UPDATE_FAILED, error: lock.error };
    }

    const baseOp = {
      operationId,
      jobId: plan.jobId,
      clientId,
      spreadsheetId: plan.spreadsheetId,
      worksheetId: plan.worksheetId,
      worksheetName: plan.worksheetName,
      targetDate: plan.targetDateLabel,
      planFingerprint: plan.planFingerprint,
      backupId: backup.backupId,
      status: OPERATION_STATES.UPDATING,
      mode,
    };

    try {
      await updateJournal.recordOperation(baseOp);

      const writeRes = await sheetsWriteClient.executeBatchUpdate({
        spreadsheetId: plan.spreadsheetId,
        requests: plan.requests,
        mode,
        dryRun,
      });

      if (!writeRes.ok) {
        if (writeRes.ambiguousOutcome) {
          const reconciled = await updateJournal.reconcileLostWriteResponse({
            sheetReader,
            operationEntry: baseOp,
            plan,
          });
          if (!reconciled.applied) {
            return {
              ok: false,
              operationStatus: reconciled.status,
              error: reconciled.error || writeRes.error,
              operationId,
              recoveryPlan: buildRecoveryPlan({
                operationEntry: reconciled.entry,
                backupRecord: backup,
                verificationIssues: [reconciled.error || writeRes.error],
              }),
            };
          }
          // Already applied according to re-read! Run full verification directly:
          const verifyAfterReconcile = verifyPostUpdateSpreadsheet({
            plan,
            preUpdateStructure: live.structure,
            preUpdateDisplayRows: live.displayRows,
            postUpdateStructure: reconciled.reread.structure,
            postUpdateDisplayRows: reconciled.reread.displayRows || live.displayRows,
          });
          return {
            ok: verifyAfterReconcile.verified,
            reconciled: true,
            operationStatus: verifyAfterReconcile.verified
              ? OPERATION_STATES.UPDATE_SUCCESSFUL
              : OPERATION_STATES.VERIFICATION_FAILED,
            operationId,
            issues: verifyAfterReconcile.issues,
          };
        }

        await updateJournal.recordOperation({
          ...baseOp,
          status: OPERATION_STATES.UPDATE_FAILED,
          apiResponse: { ok: false, code: writeRes.code, error: writeRes.error },
        });
        return {
          ok: false,
          operationStatus: OPERATION_STATES.UPDATE_FAILED,
          operationId,
          error: writeRes.error,
        };
      }

      // Step 5: Post-update verification re-read
      await updateJournal.recordOperation({
        ...baseOp,
        status: OPERATION_STATES.VERIFICATION_IN_PROGRESS,
        apiResponse: { ok: true, repliesCount: (writeRes.data?.replies || []).length },
      });

      const postLive = await readLiveValuesAndStructure({
        clientId,
        locationId: location?.locationId || null,
        client: ctx.client,
      });

      if (!postLive.ok) {
        const opSaved = await updateJournal.recordOperation({
          ...baseOp,
          status: OPERATION_STATES.VERIFICATION_FAILED,
          verificationOutcome: { verified: false, issues: [postLive.error] },
        });
        return {
          ok: false,
          operationStatus: OPERATION_STATES.VERIFICATION_FAILED,
          operationId,
          error: `Post-update re-read failed: ${postLive.error}`,
          recoveryPlan: buildRecoveryPlan({
            operationEntry: opSaved.entry,
            backupRecord: backup,
            verificationIssues: [postLive.error],
          }),
        };
      }

      const verifyRes = verifyPostUpdateSpreadsheet({
        plan,
        preUpdateStructure: live.structure,
        preUpdateDisplayRows: live.displayRows,
        postUpdateStructure: postLive.structure,
        postUpdateDisplayRows: postLive.displayRows,
      });

      if (!verifyRes.verified) {
        const opSaved = await updateJournal.recordOperation({
          ...baseOp,
          status: OPERATION_STATES.VERIFICATION_FAILED,
          verificationOutcome: { verified: false, issues: verifyRes.issues },
        });
        return {
          ok: false,
          operationStatus: OPERATION_STATES.VERIFICATION_FAILED,
          operationId,
          issues: verifyRes.issues,
          error: verifyRes.issues[0],
          recoveryPlan: buildRecoveryPlan({
            operationEntry: opSaved.entry,
            backupRecord: backup,
            verificationIssues: verifyRes.issues,
          }),
        };
      }

      // Verification succeeded! Update client snapshot cleanly to new post-update state
      await clientStorage.saveSheetSnapshot(postLive.snapshot);
      await updateJournal.recordOperation({
        ...baseOp,
        status: OPERATION_STATES.UPDATE_SUCCESSFUL,
        apiResponse: { ok: true },
        verificationOutcome: { verified: true, issues: [] },
      });

      return {
        ok: true,
        operationStatus: OPERATION_STATES.UPDATE_SUCCESSFUL,
        operationId,
        plan,
        verification: verifyRes,
      };
    } finally {
      updateJournal.releaseSpreadsheetLock(plan.spreadsheetId, operationId);
    }
  }

  return {
    generatePreview,
    executeApprovedUpdate,
  };
}
