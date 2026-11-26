# Spreadsheet Backup & Recovery Procedures (Phase 9)

## Mandatory Recoverable Backup Strategy
Before any live spreadsheet write is allowed:
1. `sheet-backup-manager.js` reads complete Google Sheets API v4 spreadsheet metadata, merged ranges, protected ranges, filters, conditional formatting rules, column widths, row heights, formatted display values, user-entered values, **and** underlying formulas (`getSpreadsheetGridDetails` + `batchGetValues`).
2. A values-only CSV or shallow JSON is **never** treated as a complete backup.
3. The full recoverable snapshot is verified (`verificationStatus: "VERIFIED"`) and stored locally in IndexedDB `backups` store (`sbkp_<clientId>_<timestamp>`). Backups are excluded from Git via `.gitignore`.
4. Live updates are blocked with `Backup required` unless a verified backup exists for the exact `(spreadsheetId, worksheetId)`.

## Handling Lost Responses / Ambiguous Timeouts
- If a `:batchUpdate` HTTP request drops or returns a server `5xx` error, `update-journal.js` **never** blindly retries column insertion.
- It re-reads the sheet via `reconcileLostWriteResponse`, verifies whether the new date column header and planned values already landed, and reconciles the journal status (`Update successful`, `Verification failed`, or `Recovery required`) safely.

## Recovery Procedure (If Verification Fails)
- The extension **never** performs an automatic destructive rollback over collaborator edits (`automaticRollbackAllowed: false`).
- On `Verification failed` or `Recovery required`:
  1. Open the target Google Sheet (`Open Original Google Sheet`).
  2. Open **File -> Version history** inside Google Sheets or click **View Backup** in the extension dashboard to inspect exact pre-update cell values, formulas, merges, widths, and formatting.
  3. Selectively restore the pre-update column/cells without overwriting collaborator edits, then re-import the spreadsheet snapshot in Digital Minds Rank Tracker.

## Known Backup Restoration Limitations
`buildRestoreBatchUpdateRequests` and `restoreFromBackup` restore captured cell values, underlying formulas, user/effective cell formatting, column widths, row heights, merged cell ranges, and worksheet basic filters via Google Sheets `spreadsheets.batchUpdate`. The following limitations must be understood before triggering restoration:
1. **Conditional formatting rules**: Conditional format rule definitions (`conditionalFormats`) are preserved inside the backup snapshot (`snapshotData.conditionalFormats`) and audited for drift by `update-verifier.js`, but are not blindly re-pushed via `addConditionalFormatRule` requests during automated restore to avoid duplicating or colliding with rule indices created after backup capture.
2. **Protected ranges & ownership permissions**: Protected ranges (`protectedRanges`) are recorded for pre-write validation and owner review, but `restoreFromBackup` cannot recreate or bypass owner-only / domain-restricted protected ranges if the signed-in Google account lacks edit/owner privileges on those protected regions.
3. **Filter views (`filterViews`)**: Named collaborator filter views are audited in snapshots rather than overwritten during restoration.
4. **Concurrent collaborator edits**: Because `restoreFromBackup` writes exact pre-backup row grid ranges, running a full restore while collaborators actively edit unrelated cells can revert their recent changes. Always verify recent activity or prefer selective cell restoration / Google Sheets Version History when concurrent edits occurred.


