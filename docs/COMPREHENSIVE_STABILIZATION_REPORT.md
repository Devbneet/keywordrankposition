# Comprehensive Stabilization Report — Digital Minds Rank Tracker (`v1.0.0-rc.2`)

**Date:** 2026-11-27  
**Branch:** `extension-development`  
**Baseline Commit:** `5d30fbf431175585f546bdb6056770c13ad6718b` (`v1.0.0-rc.1`)  
**Release Candidate:** `v1.0.0-rc.2`

---

## 1. Root-Cause Bugs Fixed Across Work Packages

| Work Package | Bug / Issue | Root Cause | Fix Implemented | Regression Test |
| :--- | :--- | :--- | :--- | :--- |
| **A. Location** | IP-based, saved-places, and country-only matches marked as `MATCHED` / live-verified | `locationMatchesTarget()` returned `matched: true` regardless of `locationSourceType`; `single-keyword-checker` only checked `MATCHED` | Added `GOOGLE_LOCATION_SOURCES`, `GOOGLE_MATCH_CLASSIFICATIONS`, `strictRankingEligible`; IP/places/activity/country-only return `NON_DEVICE_MATCH` or `AMBIGUOUS` with `strictRankingEligible: false`; cross-country identical cities (`Sydney, Canada` vs `Sydney, Australia`) rejected | `tests/stabilization-regressions.test.mjs` |
| **A. Location** | Stale Google location verification reused on subsequent SERP pages | `recordLiveCheckVerification()` preserved old `googleVerificationEvidence` when new page lacked footer; `single-keyword-checker` only stopped on `MISMATCH` | Invalidates previous verification whenever `googleFooterCheck.status !== MATCHED` or `!strictRankingEligible`, returning `LOCATION_UNVERIFIED` | `tests/stabilization-regressions.test.mjs` |
| **A. Location** | `User denied Geolocation` lacked granular cause and recovery instructions | `geolocation-verifier.js` collapsed all denial causes into `PERMISSION_DENIED` | Distinguishes `SITE_PERMISSION_BLOCKED`, `USER_DENIED_PERMISSION`, `PERMISSION_PROMPT_DENIED`, `INSECURE_CONTEXT`, `POSITION_UNAVAILABLE`, `POSITION_TIMEOUT` and returns `recoverySteps` | `tests/stabilization-regressions.test.mjs` |
| **B. Ranking** | Incomplete search falsely reported as `Not found` when `nextPageUrl` was missing | `organic-parser.js` set `endOfResultsVerified = confirmedEmpty \|\| (results.length > 0 && !nextPageUrl)` | Removed `results.length > 0 && !nextPageUrl`; only explicit end markers or `confirmedEmpty` set `endOfResultsVerified = true`; added pagination loop & duplicate-page detection in `ranking-calculator.js` | `tests/stabilization-regressions.test.mjs`, `tests/accuracy.test.mjs` |
| **B. Ranking** | Unsafe default `isAuthorized = true` | `single-keyword-checker.js` and `job-manager.js` defaulted `isAuthorized` to `true` | Changed default to `isAuthorized = false`; requires explicit `isAuthorized === true` (and UI checkbox confirmation) for live checks | `tests/stabilization-regressions.test.mjs` |
| **C. Evidence** | Inconsistent field names and unsafe `r.isLiveVerified !== false` adapter | `service-worker.js` read `checkedResultsCount` and accepted `undefined` `isLiveVerified` | Added `createCanonicalRankingResult()` and `isCanonicalLiveVerified()` in `ranking-state.js`; updated `single-keyword-checker.js`, `bulk-ranking-runner.js`, and `service-worker.js` | `tests/stabilization-regressions.test.mjs` |
| **D. Scheduler** | Non-atomic `claimExecution()` & lock writes | `claimExecution()` performed separate async `getExecution` + `saveExecution` | Added `db.atomicUpdate()` (single IDB `readwrite` tx + `WeakMap`-serialized fallback chain) used by `claimExecution()`, `acquireExecutionLock()`, and `renewExecutionLock()` | `tests/stabilization-regressions.test.mjs` |
| **D. Scheduler** | Storage failure could still mark scheduled job `COMPLETED` | `scheduled-job-runner.js` broke loop on storage error without tracking `haltedByStorage` | Added `haltedByStorage` + `try/catch`; marks job `INTERRUPTED`, skips Sheet preview/updates, and marks execution `FAILED` | `tests/stabilization-regressions.test.mjs` |
| **E. Sheets** | Repeated keyword tables classified as `Default Group` | `sheet-structure-detector.js` only checked `rIdx - 1` `keywordIdx` | Scans up to 2 non-empty rows above repeated headers for merged/col-A/keyword headings and assigns distinct `Section N` labels when unlabeled | `tests/stabilization-regressions.test.mjs` |
| **E. Sheets** | Write client lacked mode allowlist & validator missed `sourceMode` | `sheets-write-client.js` didn't reject unknown modes or short-circuit `mock`; `sheet-update-validator.js` only checked `source` | Enforced strict `UPDATE_MODES` allowlist, short-circuited `mock`, validated `sourceMode` and HTTP/HTTPS domain match | `tests/stabilization-regressions.test.mjs` |
| **F. Backups** | Backup restoration coerced leading-zero strings into numbers | `buildRestoreBatchUpdateRequests()` used `/^-?\d+(\.\d+)?$/` on `displayValues` | Uses `rawCell.userEnteredValue` directly, preserving exact string/number/boolean/formula/blank types; added read-back integrity check after backup save | `tests/stabilization-regressions.test.mjs` |
| **H. Dashboard** | Top client dropdown stayed stale after editing client domain | `syncTopbarClientDropdown()` was not called after `CLIENT_UPDATE` | Added `onOverviewsUpdated` callback in `clients.js` wired to `syncTopbarClientDropdown()` in `dashboard.js` | Manual UI verification pending |
| **H. Dashboard** | Needed quick subset selection for 109 imported keywords | No subset controls in Bulk Keyword Checker | Added `First 3`, `First 5`, `First 10`, `All`, `Deselect`, keyword search, group filter, and selected count while preserving row anchors | Manual UI verification pending |

---

## 2. Production Readiness & Pending Manual Gates

Production Google Sheet writes remain **disabled by default** until the project owner completes live Chrome verification:
1. Live 5-city Chrome geolocation & Google location verification.
2. Live 20+ keyword GS Location Changer comparison (>=90% within-1-position & URL agreement target).
3. Live Google OAuth & Sandbox spreadsheet update/restore verification on the copied 109-keyword sheet.
4. Live Chrome scheduled alarm & missed-run recovery verification.

