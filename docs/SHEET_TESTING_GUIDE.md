# Phase 9 Testing Modes & Live Sandbox Verification Guide

## 3 Testing Modes
1. **Dry-Run Mode (Default):** Generates full update plans, validates row identities, checks date columns, and renders before-and-after previews without modifying any Google Sheet.
2. **Mock Testing (`npm.cmd test`):** Runs automated unit and integration suites (`tests/sheet-*.test.mjs`) against realistic Google Sheets API v4 fixtures (`tests/fixtures/sample-sheets.js`), covering column insertion, same-date reuse, formatting requests, backups, idempotency, lost responses, and verification checks.
3. **Sandbox Testing -> Production Mode:**
   - **Never** run live writes against real client sheets before verifying on a dedicated duplicate sandbox copy of a client spreadsheet!
   - Step 1: Duplicate an agency client sheet in Google Drive as a private sandbox test sheet.
   - Step 2: Configure your Chrome Extension OAuth Client ID locally (`docs/GOOGLE_CLOUD_SETUP.md`).
   - Step 3: In the Dashboard **Google Sheets Update (Phase 9)** panel, select the sandbox sheet URL, click **Enable Write Access**, run **Generate Update Preview**, click **Create Backup**, switch mode to `Sandbox`, confirm approval checkbox, and click **Confirm Update**.
   - Step 4: Inspect the live sheet in Google Sheets to confirm navy/green/yellow formatting, column widths, historical shifts, formulas, merges, filters, and statistics preservation before enabling **Production** mode on live client sheets.

