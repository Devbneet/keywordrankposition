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

