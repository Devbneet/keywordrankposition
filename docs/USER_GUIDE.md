# User Guide — Digital Minds Rank Tracker

Welcome to **Digital Minds Rank Tracker** (`v1.0.0-rc.1`), an internal Chrome extension for location-accurate organic keyword ranking checks and design-preserving Google Sheets updates.

---

## 1. Quick Start Workflow

1. **Create or Select a Client** (`Clients` page):
   - Add the client name, primary domain (e.g., `example.com`), and one or more target locations (City, Latitude/Longitude, Country, Language, Google Domain).
   - Optionally attach the client's Google Sheet URL and target worksheet (`gid`).
2. **Verify Browser & Google Location** (`Keyword Rankings` or `Clients` -> `Start Ranking Check`):
   - Click **Apply Browser Location** to set Chrome's GPS override (`chrome.debugger`).
   - Click **Test Browser GPS** to verify the browser reports the exact coordinates.
   - Click **Apply to Google Search** and **Verify Google Location** to confirm Google Search displays a `Device-Based` match for the target city.
3. **Import or Enter Keywords**:
   - Paste keywords (one per line), upload `.csv` / `.txt`, or import directly from the client's connected Google Sheet (`Google Sheets` page).
4. **Run Ranking Check**:
   - Use **Single Keyword Check** for quick spot-checks or **Bulk Keyword Checker** for full keyword lists.
   - Use **Pause**, **Resume**, or **Stop** at any time; completed results are persisted immediately.
5. **Review History & Reports** (`Ranking History`, `Reports`, `Overview`):
   - Compare current vs previous positions (`Improved`, `Declined`, `Unchanged`, `New`, `Lost`).
   - Export sanitized CSV reports.
6. **Preview & Update Google Sheets** (`Google Sheets` page):
   - Always test against a **Sandbox** copy first (see [GOOGLE_SHEETS_SANDBOX_TESTING.md](./GOOGLE_SHEETS_SANDBOX_TESTING.md)).
   - Create a local backup, inspect the **Update Preview** (`Mode A`), and run post-update verification.
7. **Schedule Weekly Checks** (`Scheduled Checks` page):
   - Create single-client or multi-client agency batch schedules.
   - Check the authorization confirmation box (`I confirm authorized search access...`) before enabling.
   - Keep Chrome open on the host machine for scheduled alarms to fire on time.

