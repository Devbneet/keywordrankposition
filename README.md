# Digital Minds Rank Tracker (Chrome Extension)

An internal, 100% free **Chrome Extension (Manifest V3)** (`v1.0.0-rc.2`) for **Digital Minds** to check location-specific organic keyword rankings, validate accuracy against GS Location Changer, manage multiple SEO clients, schedule weekly checks, and update client Google Sheets while preserving all spreadsheet formatting and history.

> **Branch Policy:** Active extension development is on `extension-development`. The legacy Python/Playwright implementation is preserved on `backup/python-version`.

---

## Key Features (Phases 1–12)

- **Browser Geolocation Simulation (`chrome.debugger`):** Sets exact latitude/longitude/accuracy on a dedicated verification tab and verifies `navigator.geolocation` output.
- **Google Search Location Verification:** Verifies Google's displayed location (`Device-Based` vs `IP-Based`) and blocks live checks on mismatch or CAPTCHA.
- **Accurate Organic Ranking Detection:** Parses organic SERP results while excluding ads, shopping, AI Overviews, local packs, PAA, and carousels; distinguishes `Ranked`, `Not Found`, and `Incomplete`.
- **Ranking Accuracy Lab:** Compares extension rankings against GS Location Changer manual baselines with CSV/JSON export.
- **Bulk Keyword Automation & Job Recovery:** Sequential keyword queues with Pause/Resume/Stop, immediate per-keyword persistence, and interrupted-job recovery.
- **Multi-Client Isolation:** Independent client domains, target locations, keyword lists, ranking history, and Google Sheet mappings.
- **Google Sheets Integration (Read & Design-Preserving Updates):** Official Sheets API OAuth 2.0 (`spreadsheets.readonly` by default; opt-in write scope), full local backups, `Mode A` update previews, atomic `InsertDimension` + `CopyPaste(PASTE_FORMAT)` updates, and post-update verification.
- **Weekly Scheduling & Notifications:** `chrome.alarms` weekly/biweekly scheduling with DST-safe timezone math, missed-run recovery, and conflict deferral.

---

## Documentation

- [Installation Guide](./docs/INSTALLATION_GUIDE.md) (Unpacked Chrome installation)
- [User Guide](./docs/USER_GUIDE.md)
- [Google Cloud & OAuth Setup](./docs/GOOGLE_CLOUD_SETUP.md)
- [Google Sheets Sandbox Testing](./docs/GOOGLE_SHEETS_SANDBOX_TESTING.md)
- [Manual Location Test Cases (5 Cities)](./docs/MANUAL_LOCATION_TEST_CASES.md)
- [Ranking Accuracy Test Plan](./docs/RANKING_ACCURACY_TEST_PLAN.md)
- [Scheduling Guide](./docs/SCHEDULING_GUIDE.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Known Limitations](./docs/KNOWN_LIMITATIONS.md)
- [Deployment Guide (`v1.0.0-rc.1`)](./docs/DEPLOYMENT_GUIDE.md)
- [Final Testing Checklist](./docs/FINAL_TESTING_CHECKLIST.md)
- [Final Test Report](./docs/FINAL_TEST_REPORT.md)
- [Comprehensive Stabilization Report (`v1.0.0-rc.2`)](./docs/COMPREHENSIVE_STABILIZATION_REPORT.md)

---

## Running Automated Tests & Building Release Package

Requires Node.js 20+ (zero external npm dependencies):

```powershell
node --test tests/*.test.mjs
node scripts/package-release.mjs
```
