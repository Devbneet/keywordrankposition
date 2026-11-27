# Troubleshooting Guide

## 1. Location & Debugger Issues

- **"Debugger failed to attach" or `Target closed`**:
  - Close Chrome DevTools on the verification tab (only one debugger client can attach to a tab at a time).
  - Click **Reset Location**, then **Apply Browser Location** again.
- **"Location mismatch" or `IP-Based` only on Google**:
  - Google may fall back to IP geolocation if the dedicated tab did not receive GPS permission or if Google's location cookie is stale.
  - Click **Apply to Google Search**, grant location permission when prompted, and re-run **Verify Google Location**.
  - Live ranking checks are intentionally blocked until `Device-Based` location verification passes.

## 2. Ranking Check & CAPTCHA Issues

- **Check stops immediately with `CAPTCHA / Search Blocked`**:
  - Digital Minds Rank Tracker never bypasses CAPTCHAs.
  - Partial completed results are saved safely; remaining keywords stay pending (never falsely marked `Not Found`).
  - Wait before retrying, reduce batch size, or increase the delay between keywords.
- **Keyword marked `Incomplete` instead of `Not Found`**:
  - Occurs when pagination stops before the configured search depth (e.g., `50`) without a confirmed end-of-results. Re-run the keyword when Google Search loads normally.

## 3. Google Sheets & OAuth Issues

- **`OAuth token expired` or `401` / `403` errors**:
  - Open **Google Sheets** -> click **Disconnect**, then **Connect Google Account** again.
  - Confirm your Google account is listed under Test Users in Google Cloud Console (if OAuth consent is in `Testing` mode) and has access to the spreadsheet.
- **Write scope blocked**:
  - Phase 8 is read-only by default. Opt-in write access (`spreadsheets` scope) must be explicitly enabled before Sandbox/Sheet updates.
- **Structure Drift Detected**:
  - Someone edited rows, headers, or columns in the Google Sheet since the last snapshot. Re-read and confirm the updated sheet structure before planning an update.

## 4. Scheduled Checks Issues

- **Schedule did not run at the configured time**:
  - Chrome must be running and the computer awake. When Chrome restarts, the missed-run detector surfaces overdue runs on the **Scheduled Checks** page.
- **Schedule fails immediately with `AUTH_EXPIRED`**:
  - Edit the schedule and confirm **I confirm authorized search access for this scheduled check** is checked, and ensure Google OAuth is connected if `Import latest keywords from Google Sheet` is enabled.
- **Schedule shows `Queued` / Deferred**:
  - A manual ranking check, client switch, or Google Sheet write lock is currently active. The queue automatically resumes once the lock clears.

