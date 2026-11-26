/**
 * Canonical constants, state machines, automation safety modes, and lock definitions
 * for Digital Minds Rank Tracker Phase 11 Weekly Scheduling & Recovery.
 */

export const SCHEDULE_FREQUENCIES = Object.freeze({
  WEEKLY: "weekly",
  BIWEEKLY: "biweekly",
  DAILY: "daily",
});

export const DAY_NAMES = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

export const DAYS_OF_WEEK = Object.freeze({
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
});

export const SCHEDULE_STATES = Object.freeze({
  ENABLED: "Enabled",
  DISABLED: "Disabled",
  RUNNING: "Running",
  MISSED: "Missed",
  NEEDS_ATTENTION: "Needs attention",
  COMPLETED: "Completed",
  FAILED: "Failed",
  PAUSED: "Paused",
});

export const EXECUTION_STATES = Object.freeze({
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  COMPLETED_WITH_ERRORS: "Completed with errors",
  SHEET_PREVIEW_READY: "Sheet update preview ready",
  MISSED_PENDING: "Missed (awaiting action)",
  SKIPPED: "Skipped",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
});

/**
 * Mode A is mandatory default: performs scheduled ranking checks + history persistence +
 * dry-run Google Sheet update preview preparation for human approval.
 * Mode B (auto sheet writes) remains disabled on production sheets until Phase 12 sandbox proof.
 */
export const AUTOMATION_MODES = Object.freeze({
  MODE_A_REVIEW: "mode_a_check_with_review",
  MODE_B_AUTO_SHEET: "mode_b_auto_sheet_update",
});

export const MISSED_RUN_POLICIES = Object.freeze({
  ASK_USER: "ask_user",
  RUN_LATEST: "run_latest",
  SKIP: "skip",
  RESUME_NEXT: "resume_next",
});

export const LOCK_TYPES = Object.freeze({
  MANUAL_SINGLE: "manual_single_check",
  MANUAL_BULK: "manual_bulk_job",
  SCHEDULED_JOB: "scheduled_job",
  CLIENT_SWITCH: "client_switch",
  SHEET_WRITE: "sheet_write",
  BACKUP_RESTORE: "backup_restore",
});

export const RETRY_CONFIG = Object.freeze({
  maxKeywordRetries: 2,
  keywordRetryDelayMs: 2500,
  maxTransientSheetRetries: 2,
  transientSheetRetryDelayMs: 2000,
  stopOnCaptcha: true,
  stopOnLocationMismatch: true,
  minDelayBetweenKeywordsMs: 2000,
  defaultDelayBetweenKeywordsMs: 3500,
  defaultDelayBetweenClientsMs: 5000,
});

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: true,
  onCompleted: true,
  onCompletedWithErrors: true,
  onMissedRun: true,
  onAuthRequired: true,
  onCaptchaBlocked: true,
  onLocationFailed: true,
  onSheetPreviewReady: true,
});

export const DEFAULT_SCHEDULER_SETTINGS = Object.freeze({
  defaultAutomationMode: AUTOMATION_MODES.MODE_A_REVIEW,
  defaultMissedRunPolicy: MISSED_RUN_POLICIES.ASK_USER,
  unattendedProdSheetWritesEnabled: false,
  missedRunGraceMinutes: 15,
  delayBetweenKeywordsMs: RETRY_CONFIG.defaultDelayBetweenKeywordsMs,
  delayBetweenClientsMs: RETRY_CONFIG.defaultDelayBetweenClientsMs,
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
});

export const SCHEDULE_FAILURE_CODES = Object.freeze({
  MISSING_CLIENT: "missing_client",
  MISSING_LOCATION: "missing_location",
  MISSING_KEYWORDS: "missing_keywords",
  AUTH_EXPIRED: "google_auth_expired",
  WRITE_SCOPE_MISSING: "google_write_scope_missing",
  GPS_LOCATION_FAILED: "gps_location_verification_failed",
  GOOGLE_LOCATION_FAILED: "google_location_verification_failed",
  CAPTCHA_BLOCKED: "captcha_or_rate_limited",
  SHEET_STRUCTURE_DRIFT: "sheet_structure_changed",
  SHEET_IMPORT_FAILED: "sheet_import_failed",
  SHEET_PREVIEW_FAILED: "sheet_preview_failed",
  BACKUP_FAILED: "sheet_backup_failed",
  CONFLICT_DEFERRED: "active_operation_conflict",
  UNEXPECTED_ERROR: "unexpected_execution_error",
});

