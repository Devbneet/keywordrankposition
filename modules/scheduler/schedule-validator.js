/**
 * Strict validator for weekly/recurring SEO ranking schedules.
 * Prevents broken configs, invalid timezones, missing location/client mappings,
 * and unsafe unattended production Google Sheet write activation.
 */

import {
  isValidIanaTimezone,
  normalizeDayOfWeek,
  parseTimeOfDay,
} from "./schedule-calculator.js";
import {
  AUTOMATION_MODES,
  MISSED_RUN_POLICIES,
  RETRY_CONFIG,
  SCHEDULE_FREQUENCIES,
} from "./scheduler-state.js";

export function validateScheduleInput(
  input = {},
  { clientsById = null, locationsByClient = null, schedulerSettings = null } = {}
) {
  const errors = [];
  const warnings = [];

  const scopeType = input.scopeType === "agency_batch" ? "agency_batch" : "single_client";
  const frequency = Object.values(SCHEDULE_FREQUENCIES).includes(input.frequency)
    ? input.frequency
    : null;
  if (!frequency) {
    errors.push(`Unsupported frequency '${input.frequency}'. Choose weekly, biweekly, or daily.`);
  }

  const timeCheck = parseTimeOfDay(input.timeOfDay);
  if (!timeCheck.valid) {
    errors.push(`Invalid timeOfDay '${input.timeOfDay}'. Expected 24h HH:MM format (e.g. 09:00).`);
  }

  const dow = normalizeDayOfWeek(input.dayOfWeek);
  const timezone = String(input.timezone || "").trim();
  if (!isValidIanaTimezone(timezone)) {
    errors.push(`Invalid IANA timezone '${timezone}'. Use a valid zone such as 'Australia/Sydney' or 'UTC'.`);
  }

  const missedRunPolicy = input.missedRunPolicy || MISSED_RUN_POLICIES.ASK_USER;
  if (!Object.values(MISSED_RUN_POLICIES).includes(missedRunPolicy)) {
    errors.push(`Unsupported missedRunPolicy '${missedRunPolicy}'.`);
  }

  const automationMode = input.automationMode || AUTOMATION_MODES.MODE_A_REVIEW;
  if (!Object.values(AUTOMATION_MODES).includes(automationMode)) {
    errors.push(`Unsupported automationMode '${automationMode}'.`);
  }

  // Enforce safety rule: Mode B unattended production writes remain disabled unless sandbox + explicit toggle
  if (automationMode === AUTOMATION_MODES.MODE_B_AUTO_SHEET) {
    const isSandbox = Boolean(input.sandboxMode);
    const prodAllowed = Boolean(schedulerSettings?.unattendedProdSheetWritesEnabled);
    if (!isSandbox && !prodAllowed) {
      errors.push(
        "Unattended Mode B Google Sheet writes on production client sheets are disabled for safety until Phase 12 sandbox verification. Use Mode A (Ranking check + sheet preview for review) or Sandbox testing."
      );
    }
  }

  const delayBetweenKeywordsMs = Number(
    input.delayBetweenKeywordsMs ?? RETRY_CONFIG.defaultDelayBetweenKeywordsMs
  );
  if (!Number.isFinite(delayBetweenKeywordsMs) || delayBetweenKeywordsMs < RETRY_CONFIG.minDelayBetweenKeywordsMs) {
    errors.push(
      `Keyword delay must be at least ${RETRY_CONFIG.minDelayBetweenKeywordsMs}ms to preserve conservative authorized pacing.`
    );
  }

  const searchDepth = Number(input.searchDepth || 50);
  if (!Number.isInteger(searchDepth) || searchDepth < 10 || searchDepth > 100) {
    errors.push("searchDepth must be between 10 and 100.");
  }

  if (scopeType === "single_client") {
    if (!input.clientId) {
      errors.push("clientId is required for single-client schedules.");
    } else if (clientsById) {
      const client = clientsById.get(input.clientId);
      if (!client) {
        errors.push(`Client '${input.clientId}' does not exist.`);
      } else if (!client.websiteDomain) {
        errors.push(`Client '${client.clientName || input.clientId}' is missing websiteDomain.`);
      } else if (locationsByClient) {
        const locs = locationsByClient.get(input.clientId) || [];
        if (input.locationId && !locs.some((l) => l.locationId === input.locationId)) {
          errors.push(`Selected location '${input.locationId}' does not belong to client '${input.clientId}'.`);
        } else if (locs.length === 0) {
          errors.push(`Client '${client.clientName || input.clientId}' has no saved target location.`);
        }
      }
    }
  } else {
    const entries = Array.isArray(input.clientConfigs) ? input.clientConfigs : [];
    if (entries.length === 0) {
      errors.push("Agency batch schedule requires at least one entry in clientConfigs.");
    } else if (clientsById) {
      const seenClients = new Set();
      for (const entry of entries) {
        if (!entry?.clientId) {
          errors.push("Each agency batch item requires a clientId.");
          continue;
        }
        const key = `${entry.clientId}::${entry.locationId || "default"}`;
        if (seenClients.has(key)) {
          warnings.push(`Duplicate client/location entry '${key}' will be deduplicated.`);
        }
        seenClients.add(key);
        const client = clientsById.get(entry.clientId);
        if (!client) {
          errors.push(`Batch client '${entry.clientId}' does not exist.`);
        } else if (locationsByClient) {
          const locs = locationsByClient.get(entry.clientId) || [];
          if (locs.length === 0) {
            errors.push(`Batch client '${client.clientName || entry.clientId}' has no saved target location.`);
          } else if (entry.locationId && !locs.some((l) => l.locationId === entry.locationId)) {
            errors.push(`Batch location '${entry.locationId}' not found for client '${entry.clientId}'.`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: {
      scopeType,
      frequency: frequency || SCHEDULE_FREQUENCIES.WEEKLY,
      dayOfWeek: dow,
      timeOfDay: timeCheck.normalized || "09:00",
      timezone: isValidIanaTimezone(timezone) ? timezone : "Australia/Sydney",
      automationMode,
      missedRunPolicy,
      delayBetweenKeywordsMs,
      searchDepth,
    },
  };
}

