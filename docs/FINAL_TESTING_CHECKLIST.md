# Final Testing & Acceptance Checklist (`v1.0.0-rc.1`)

Status legend:
- **Automated test passed** — Verified via `node --test tests/*.test.mjs`
- **Manual verification pending** — Requires live Chrome / Google account / Sandbox Sheet execution
- **Implemented** — Code and configuration complete

| # | Verification Item | Status | Reference |
| :--- | :--- | :--- | :--- |
| 1 | Manifest V3 structure, permissions, icons, popup, and 12 dashboard views | Automated test passed | `tests/smoke.test.mjs` |
| 2 | Zero broken relative JS imports (90 files) and zero hardcoded secrets | Implemented | Static audit |
| 3 | Browser geolocation simulation (`chrome.debugger` / `Emulation.setGeolocationOverride`) | Automated test passed | `tests/location.test.mjs` |
| 4 | Google Search location verification (Device-Based vs IP-Based, exact city boundary) | Automated test passed | `tests/google-location.test.mjs` |
| 5 | Manual 5-city Chrome verification (Sydney, Melbourne, London, New York, Delhi) | Manual verification pending | [MANUAL_LOCATION_TEST_CASES.md](./MANUAL_LOCATION_TEST_CASES.md) |
| 6 | Single keyword organic ranking parser & pagination (ads/AI/local excluded) | Automated test passed | `tests/ranking.test.mjs` |
| 7 | Ranking Accuracy Lab & GS Location Changer comparison (20+ keywords, >=90% target) | Manual verification pending | [RANKING_ACCURACY_TEST_PLAN.md](./RANKING_ACCURACY_TEST_PLAN.md) |
| 8 | Bulk keyword automation (10/50/100 queues, Pause/Resume/Stop, CAPTCHA halt) | Automated test passed | `tests/bulk-ranking.test.mjs` |
| 9 | Multi-client isolation (5 agency clients, location reset on switch, cascade delete) | Automated test passed | `tests/multi-client.test.mjs` |
| 10 | Google Cloud OAuth 2.0 read-only & opt-in write scope gating | Automated test passed | `tests/google-auth.test.mjs` |
| 11 | Google Sheets read-only structure detection & row preservation | Automated test passed | `tests/sheets-reader.test.mjs` |
| 12 | Google Sheets backup, update preview, atomic batchUpdate & post-update verification | Automated test passed | `tests/sheet-updater.test.mjs` |
| 13 | Live Google Sheets Sandbox testing & backup restore verification | Manual verification pending | [GOOGLE_SHEETS_SANDBOX_TESTING.md](./GOOGLE_SHEETS_SANDBOX_TESTING.md) |
| 14 | Weekly scheduling, DST calculations, missed-run recovery & queue locking | Automated test passed | `tests/scheduler.test.mjs` |
| 15 | Phase 12 scheduler & runner safety fixes (no location fallback, immediate save, explicit auth) | Automated test passed | `tests/phase12-regressions.test.mjs` |
| 16 | Unpacked `v1.0.0-rc.1` release package generation (`scripts/package-release.mjs`) | Implemented | [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) |

