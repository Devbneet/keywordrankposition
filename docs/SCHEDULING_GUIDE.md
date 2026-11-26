# Weekly Scheduling Guide — Digital Minds Rank Tracker

## Overview
Digital Minds Rank Tracker uses Chrome's built-in **Alarms API** (`chrome.alarms`) and IndexedDB persistence (`dm_rank_tracker_db` v5) to run automated weekly ranking checks sequentially across single clients or multi-client agency batches without blocking manual workflows or silently mutating Google Sheets.

## Supported Schedule Types
1. **Single-Client Schedule**: Targets one SEO client, one verified location configuration, and either the client's saved keyword list or Google Sheet keyword list.
2. **Agency-Wide Multi-Client Weekly Batch**: Runs an ordered list of clients (`clientConfigs`) sequentially with conservative delays between clients (`delayBetweenClientsMs`, default 5000 ms) and between keywords (`delayBetweenKeywordsMs`, minimum 2000 ms, default 3500 ms). Parallel Google search tabs are never allowed.

## Timezone & Daylight Saving Time (DST) Safety
- Schedules accept exact **IANA timezone names** (such as `Australia/Sydney`, `Europe/London`, `America/New_York`, `UTC`) alongside `dayOfWeek` and 24-hour `timeOfDay` (`HH:MM`).
- Next occurrence timestamps (`nextScheduledRunAt`) are recalculated calendar-day-by-calendar-day via `Intl.DateTimeFormat`, rather than adding fixed `168 * 3600 * 1000` milliseconds.
- A Monday 09:00 AM `Australia/Sydney` check stays at **09:00 AM Sydney local time** across DST Spring-Forward and Fall-Back transitions.

## Safety Automation Modes (Mode A vs Mode B)
- **Mode A (Default & Recommended): Check Rankings & Prepare Sheet Update Preview**:
  - Verifies Google Sheets authorization and checks for unexpected spreadsheet structure drift.
  - Verifies browser GPS coordinates and Google Search location before searching.
  - Checks keywords sequentially, saves verified results to local Ranking History (`resultId` deduplicated across recovery), and prepares a dry-run Google Sheet Update Preview (`SHEET_PREVIEW_READY`).
  - Requires human review and explicit confirmation inside **Google Sheets** before writing to the live spreadsheet.
- **Mode B: Scheduled Backup & Update (Sandbox Only)**:
  - Unattended Mode B production Google Sheet writes are **disabled by default** (`unattendedProdSheetWritesEnabled: false`).
  - Only permitted against explicit Sandbox test fixtures (`sandboxMode: true`), using cryptographic `approvedPlanFingerprint` and `preWriteSnapshotFingerprint` backup verification before any `:batchUpdate`.

## Alarms & Startup Reconciliation
- Chrome Alarms do not drift in memory: `alarm-controller.js` registers single-shot exact wall-clock alarms (`dm_sched::<scheduleId>`) and reconciles all alarms on `chrome.runtime.onStartup`, `chrome.runtime.onInstalled`, and after every schedule update.
- Scheduled runs use a persistent idempotent execution key (`scheduleId::scheduledForAt`) so duplicate Chrome alarm wakes can never execute the same weekly occurrence twice.

