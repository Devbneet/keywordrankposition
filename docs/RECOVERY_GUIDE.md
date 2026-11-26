# Missed Run Detection, Error Recovery & Conflict Resolution Guide

## Missed Run Handling Policies
When Chrome starts or the service worker wakes up, `missed-run-recovery.js` inspects all enabled schedules for overdue occurrences past `missedRunGraceMinutes` (default: **15 minutes**):

- **`ask_user` (Default)**:
  - Logs an idempotent `Missed (awaiting action)` record in `SCHEDULE_EXECUTIONS`, sends a Chrome Notification (`Missed schedule`), marks the schedule `Missed`, and advances `nextScheduledRunAt` to the next upcoming slot so future weekly cycles stay intact.
  - Inside **Scheduled Checks -> Missed Runs Requiring Action**, you can choose **Run Missed Now** or **Skip Missed Run**.
- **`run_latest`**:
  - Enqueues **only the single most recent** missed occurrence (never flooding/bursting multiple overdue weeks back-to-back) and records skipped intermediate occurrences for audit clarity.
- **`skip`**:
  - Records a `Skipped` execution entry cleanly and moves on to the next future slot.
- **`resume_next`**:
  - Clears overdue state silently and aligns the next alarm to the next upcoming weekly slot.

## Handling Failures & Partial Runs
| Failure Condition | Extension Behavior | Required Agency Action |
|---|---|---|
| **Google OAuth Expired / Revoked** | Stops client step before searching; emits `Needs attention` & notification. | Open **Google Sheets -> Reconnect**, then click **Run Now**. |
| **Spreadsheet Structure Drift** | Blocks sheet-linked keyword overwrite; preserves previous baseline. | Review drift in **Google Sheets -> Preview**, confirm structure sync. |
| **GPS / Google Location Verification Failed** | Halts run before opening ranking searches; never stores invalid location rankings. | Verify visible tab, coordinates & location settings, then re-run. |
| **Transient Keyword Error** | Retries up to `maxKeywordRetries` (default 2) with delay; records `Failed` if exhausted (never `NA`). | Inspect Error report; re-run missing keywords if temporary network issue. |
| **CAPTCHA / Unusual Traffic** | Stops entire batch immediately (no retry/bypass); preserves completed rows. | Wait and verify browser search access manually before re-enabling. |
| **Active Manual / Sheet Lock Conflict** | Defers queued schedule occurrence via `dm_queue_drain` alarm cleanly. | Execution resumes automatically once manual check/write completes. |

