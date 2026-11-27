# Google Sheets Sandbox Testing Procedure

This procedure verifies **Phase 8 (Read-Only Import)** and **Phase 9 (Design-Preserving Updates)** against a dedicated **sandbox copy** of a client Google Sheet before any production sheet is touched.

> **Mandatory Safety Rule:** Never test against a live production client spreadsheet without explicit project owner authorization. Always duplicate a test sheet into a Sandbox Google Sheet first.

---

## 1. Prepare the Sandbox Spreadsheet

1. Duplicate a representative client spreadsheet in Google Drive and rename it `[SANDBOX] DM Rank Tracker Test Sheet`.
2. Confirm the sandbox sheet contains:
   - Historical date columns (e.g., `23-Nov`, `16-Nov`) with existing rank numbers and styling.
   - Merged header/group cells, `Volume`, `Comp`, `SERP` columns, and summary/stats formula rows (e.g., `Top 3`, `Top 10`).
   - Duplicate keywords or multi-group sections if used by the agency.

## 2. Phase 8 Read-Only Verification

1. Open Dashboard -> **Google Sheets**.
2. Click **Connect Google Account** and authorize `https://www.googleapis.com/auth/spreadsheets.readonly`.
3. Select the test client and paste the **Sandbox** Google Sheet URL.
4. Click **Load Worksheets**, select the target worksheet tab (never relies on silent `sheets[0]` fallback), and click **Preview & Read Sheet**.
5. Verify:
   - Detected keyword count, group headers, stats rows, and historical date columns match the sandbox sheet.
   - Original row numbers (`rowIndex`) are preserved.
   - **Zero** write requests are made during Phase 8.

## 3. Phase 9 Backup, Preview & Atomic Update Verification

1. Enable **Sandbox Mode** and grant opt-in write scope (`https://www.googleapis.com/auth/spreadsheets`) only when testing writes.
2. Run **Create Spreadsheet Backup** and verify a local backup snapshot (grid, formulas, merges, formatting, column widths) is saved.
3. Run **Generate Update Preview** (`Mode A`) using verified ranking results and confirm:
   - New date header matches the spreadsheet's existing date format and timezone.
   - Historical columns, `Volume`, `Comp`, and existing keyword rows are untouched.
   - Incomplete/CAPTCHA/manual-HTML results are **excluded** from spreadsheet writes.
4. Apply the update to the **Sandbox** sheet and run **Post-Update Verification**:
   - Confirm `InsertDimension` + `CopyPaste(PASTE_FORMAT)` shifted historical columns cleanly.
   - Confirm all formulas, merges, conditional formatting, and historical ranks remain intact.
   - Test **Restore from Backup** on the sandbox sheet if testing rollback.

