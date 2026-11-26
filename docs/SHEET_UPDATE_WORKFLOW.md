# Google Sheets Atomic Update Workflow (Phase 9)

All updates follow `SHEET_REQUIREMENTS.md` and prioritize spreadsheet design preservation and data integrity over speed.

## Lifecycle States
- `Ready` -> `Authentication required` / `Read-only access`
- `Preview generated` -> `Structure changed` (if baseline/template drifted)
- `Backup required` -> `Backup verified` -> `Awaiting confirmation`
- `Updating` -> `Verification in progress` -> `Update successful` / `Update failed` / `Verification failed` / `Recovery required`

## Step-by-Step Safeguards
1. **Live Verification Gate:** Only confirmed live organic rankings (`isLiveVerified === true`) and depth-verified `NA` results are eligible. Manual SERP HTML, mock fixtures, blocked searches, CAPTCHA, unverified locations, and incomplete/stopped tasks NEVER overwrite rankings or write `NA`.
2. **Row Identity Check:** Every task matches `clientId + locationId + spreadsheetId + worksheetId + rowNumber + keyword`.
3. **Date Header Resolution:**
   - Formats the target reporting date using the spreadsheet's `locale` and `timeZone`.
   - Checks **all** repeated header rows. If the same date is already active consistently in the latest ranking column, reuses that column without inserting a duplicate (preserving existing same-date valid ranks when failed tasks are skipped).
   - If historical or inconsistent duplicate dates already exist, halts safely.
4. **Single Atomic `spreadsheets.batchUpdate`:**
   - `insertDimension`: Inserts 1 physical column immediately after the SERP column (`inheritFromBefore: false`).
   - `copyPaste` (`PASTE_FORMAT`): Copies colors, font family/size/bold/color, borders, alignments, wrapping, and number formats from the shifted previous ranking column—never old values or formulas.
   - `updateDimensionProperties`: Preserves column `pixelSize` width.
   - `updateCells` (`fields: "userEnteredValue"`): Updates date headers across all keyword groups cleanly, writes verified numeric positions, updates verified SERP URLs (for confirmed ranked rows), and leaves website statistics metric cells blank.
5. **Pre-Write Revalidation & Single-Flight Concurrency:** Re-reads the live sheet immediately before calling `:batchUpdate` and rejects execution if `planFingerprint` drifted since preview approval, or if an extension lock already exists on that `spreadsheetId`. *(Note: Google Sheets API `batchUpdate` is atomic per API call, but does not lock concurrent external human edits in the browser.)*
6. **Post-Update Verification:** Re-reads the updated sheet to confirm column shifts, date headers, rank values, SERP URLs, historical preservation, formula shift adjustments, merges, filters, conditional formatting, column widths, and website statistics integrity.

