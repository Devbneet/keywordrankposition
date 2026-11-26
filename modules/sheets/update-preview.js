/**
 * Builds strict read-only Dry-Run Preview models and ties approval cleanly
 * to exact planFingerprint so any sheet or job drift invalidates prior approval.
 */

export function buildDryRunPreview({
  plan,
  backupRecord = null,
  structureStatus = "Verified",
} = {}) {
  const backupVerified = Boolean(
    backupRecord &&
      backupRecord.verificationStatus === "VERIFIED" &&
      backupRecord.spreadsheetId === plan.spreadsheetId
  );

  return {
    mode: "dry-run",
    planFingerprint: plan.planFingerprint,
    approved: false,
    clientName: plan.clientName,
    clientId: plan.clientId,
    spreadsheetId: plan.spreadsheetId,
    spreadsheetTitle: plan.spreadsheetTitle || plan.spreadsheetId,
    worksheetId: plan.worksheetId,
    worksheetName: plan.worksheetName,
    locationName: plan.locationName,
    jobId: plan.jobId,
    reportingDate: plan.targetDateLabel,
    existingLatestDate: plan.existingLatestDate,
    willInsertColumn: Boolean(plan.willInsertColumn),
    targetColumnLetter: plan.targetColumnLetter,
    totalKeywordRows: plan.totalKeywordRows,
    validRankingUpdates: plan.validRankingUpdates,
    confirmedNaUpdates: plan.confirmedNaUpdates,
    skippedOrFailedCount: plan.skippedOrFailedCount,
    serpUrlsToUpdate: plan.serpUrlsToUpdate,
    dateHeadersToUpdate: plan.dateHeadersToUpdate,
    backupStatus: backupVerified ? `Verified (${backupRecord.backupId})` : "Backup required",
    backupVerified,
    structureStatus,
    risks: plan.warnings || [],
    beforeAfterRows: plan.beforeAfterRows || [],
  };
}

export function approvePreviewPlan({ preview, confirmedByUser = false }) {
  if (!confirmedByUser) {
    return {
      ok: false,
      error: "Explicit user confirmation of the reviewed preview is required.",
    };
  }
  if (!preview?.planFingerprint) {
    return { ok: false, error: "Invalid preview payload." };
  }
  return {
    ok: true,
    approvedFingerprint: preview.planFingerprint,
    approvedAt: new Date().toISOString(),
  };
}

