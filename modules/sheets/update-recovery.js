/**
 * Non-destructive recovery guidance & restore-batch builder from verified backups.
 * NEVER triggers automatic destructive rollbacks over collaborator edits.
 */

export function buildRecoveryPlan({ operationEntry, backupRecord, verificationIssues = [] } = {}) {
  const hasBackup = Boolean(backupRecord?.backupId && backupRecord.verificationStatus === "VERIFIED");

  return {
    requiresManualReview: true,
    automaticRollbackAllowed: false,
    operationId: operationEntry?.operationId || null,
    backupId: backupRecord?.backupId || null,
    backupAvailable: hasBackup,
    verificationIssues,
    steps: [
      "1. Do NOT overwrite recent collaborator changes automatically.",
      "2. Open the Google Sheet and compare the target column against the post-update verification issues listed below.",
      hasBackup
        ? `3. Use verified pre-update backup '${backupRecord.backupId}' (captured ${backupRecord.createdAt}) or Google Sheets File -> Version History to restore impacted cells/columns selectively.`
        : "3. Open Google Sheets File -> Version History immediately to inspect and restore the prior version.",
      "4. Re-import the spreadsheet snapshot cleanly in Digital Minds Rank Tracker before attempting another update.",
    ],
  };
}

