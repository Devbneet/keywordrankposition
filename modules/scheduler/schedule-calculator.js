/**
 * DST-safe, IANA-timezone-aware calendar schedule calculator using Intl.DateTimeFormat.
 * Never adds fixed 168 * 3600 * 1000 millisecond intervals so local wall-clock schedule times
 * remain exact across Daylight Saving Time transitions and leap years.
 */

import { DAY_NAMES, SCHEDULE_FREQUENCIES } from "./scheduler-state.js";

const WEEKDAY_MAP = Object.freeze({
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
});

export function normalizeDayOfWeek(dayOfWeek) {
  if (typeof dayOfWeek === "number" && Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6) {
    return dayOfWeek;
  }
  const key = String(dayOfWeek ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, key)) {
    return WEEKDAY_MAP[key];
  }
  const parsed = Number(dayOfWeek);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 6) {
    return parsed;
  }
  return 1; // Default Monday
}

export function parseTimeOfDay(timeStr = "09:00") {
  const m = String(timeStr || "09:00").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { valid: false, hour: 9, minute: 0 };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { valid: false, hour: 9, minute: 0 };
  }
  return {
    valid: true,
    hour,
    minute,
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function isValidIanaTimezone(timezone) {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(dateInput = new Date(), timezone = "Australia/Sydney") {
  const tz = isValidIanaTimezone(timezone) ? timezone : "UTC";
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === "24" ? 0 : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    dayOfWeek: WEEKDAY_MAP[String(map.weekday || "monday").toLowerCase()] ?? 1,
    timezone: tz,
  };
}

export function addCalendarDays({ year, month, day }, daysToAdd) {
  const utc = new Date(Date.UTC(year, month - 1, day + daysToAdd, 12, 0, 0));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/**
 * Convert a wall-clock date/time in an IANA timezone to exact UTC epoch milliseconds.
 * Safely handles DST transitions:
 * - Standard days: exact wall-clock match.
 * - Fall-back (ambiguous repeated hour): converges deterministically.
 * - Spring-forward (skipped gap e.g. 02:30): steps forward to first valid local instant after the gap.
 */
export function zonedWallClockToUtcMs({ year, month, day, hour, minute }, timezone = "Australia/Sydney") {
  const tz = isValidIanaTimezone(timezone) ? timezone : "UTC";
  const desiredUtcWall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desiredUtcWall;

  for (let i = 0; i < 4; i += 1) {
    const obs = getZonedParts(guess, tz);
    const observedUtcWall = Date.UTC(obs.year, obs.month - 1, obs.day, obs.hour, obs.minute, 0, 0);
    const diff = desiredUtcWall - observedUtcWall;
    if (diff === 0) {
      return guess;
    }
    guess += diff;
  }

  // Check if local time fell inside a DST spring-forward gap
  const finalObs = getZonedParts(guess, tz);
  if (finalObs.hour !== hour || finalObs.minute !== minute || finalObs.day !== day) {
    // Advance in 1-minute steps until wall clock >= desired (hour, minute) on that calendar date
    let probe = guess - 60 * 60000;
    for (let step = 0; step < 180; step += 1) {
      const p = getZonedParts(probe, tz);
      const pWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
      if (pWall >= desiredUtcWall) {
        return probe;
      }
      probe += 60000;
    }
  }
  return guess;
}

export function stepScheduleOccurrenceDate(dateParts, frequency = SCHEDULE_FREQUENCIES.WEEKLY) {
  if (frequency === SCHEDULE_FREQUENCIES.DAILY) {
    return addCalendarDays(dateParts, 1);
  }
  if (frequency === SCHEDULE_FREQUENCIES.BIWEEKLY) {
    return addCalendarDays(dateParts, 14);
  }
  return addCalendarDays(dateParts, 7);
}

/**
 * Compute the next valid scheduled run timestamp after `afterDate` in `timezone`.
 */
export function calculateNextRunAt({
  dayOfWeek = 1,
  timeOfDay = "09:00",
  timezone = "Australia/Sydney",
  frequency = SCHEDULE_FREQUENCIES.WEEKLY,
  afterDate = new Date(),
  lastScheduledRunAt = null,
} = {}) {
  const tz = isValidIanaTimezone(timezone) ? timezone : "UTC";
  const targetDow = normalizeDayOfWeek(dayOfWeek);
  const { hour, minute } = parseTimeOfDay(timeOfDay);
  const afterMs = afterDate instanceof Date ? afterDate.getTime() : Date.parse(afterDate);
  const safeAfterMs = Number.isFinite(afterMs) ? afterMs : Date.now();

  if (frequency === SCHEDULE_FREQUENCIES.BIWEEKLY && lastScheduledRunAt) {
    const prevParts = getZonedParts(lastScheduledRunAt, tz);
    let candidateDate = { year: prevParts.year, month: prevParts.month, day: prevParts.day };
    for (let guard = 0; guard < 120; guard += 1) {
      candidateDate = stepScheduleOccurrenceDate(candidateDate, frequency);
      const ms = zonedWallClockToUtcMs({ ...candidateDate, hour, minute }, tz);
      if (ms > safeAfterMs) {
        return {
          utcMs: ms,
          iso: new Date(ms).toISOString(),
          timezone: tz,
          localParts: getZonedParts(ms, tz),
        };
      }
    }
  }

  const nowParts = getZonedParts(safeAfterMs, tz);
  const initialDayOffset =
    frequency === SCHEDULE_FREQUENCIES.DAILY ? 0 : (targetDow - nowParts.dayOfWeek + 7) % 7;

  let candidateDate = addCalendarDays(
    { year: nowParts.year, month: nowParts.month, day: nowParts.day },
    initialDayOffset
  );
  let candidateMs = zonedWallClockToUtcMs({ ...candidateDate, hour, minute }, tz);

  if (candidateMs <= safeAfterMs) {
    candidateDate = stepScheduleOccurrenceDate(candidateDate, frequency);
    candidateMs = zonedWallClockToUtcMs({ ...candidateDate, hour, minute }, tz);
  }

  return {
    utcMs: candidateMs,
    iso: new Date(candidateMs).toISOString(),
    timezone: tz,
    localParts: getZonedParts(candidateMs, tz),
  };
}

/**
 * Detect whether one or more scheduled occurrences were missed because Chrome/computer was off
 * beyond `graceMinutes` past `schedule.nextScheduledRunAt`.
 */
export function detectMissedOccurrences({
  schedule,
  now = new Date(),
  graceMinutes = 15,
  maxLookbackOccurrences = 8,
} = {}) {
  if (!schedule?.enabled || !schedule.nextScheduledRunAt) {
    return {
      hasMissed: false,
      missedCount: 0,
      missedOccurrences: [],
      latestMissedAt: null,
      earliestMissedAt: null,
      nextUpcoming: schedule?.nextScheduledRunAt || null,
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const firstDueMs = Date.parse(schedule.nextScheduledRunAt);
  const graceMs = Math.max(1, Number(graceMinutes || 15)) * 60 * 1000;

  if (!Number.isFinite(firstDueMs) || !Number.isFinite(nowMs) || nowMs - firstDueMs < graceMs) {
    return {
      hasMissed: false,
      missedCount: 0,
      missedOccurrences: [],
      latestMissedAt: null,
      earliestMissedAt: null,
      nextUpcoming: schedule.nextScheduledRunAt,
    };
  }

  const tz = isValidIanaTimezone(schedule.timezone) ? schedule.timezone : "UTC";
  const { hour, minute } = parseTimeOfDay(schedule.timeOfDay);
  const freq = schedule.frequency || SCHEDULE_FREQUENCIES.WEEKLY;

  const missedOccurrences = [];
  let cursorDate = (() => {
    const p = getZonedParts(firstDueMs, tz);
    return { year: p.year, month: p.month, day: p.day };
  })();
  let cursorMs = firstDueMs;

  while (cursorMs + graceMs <= nowMs && missedOccurrences.length < maxLookbackOccurrences) {
    missedOccurrences.push(new Date(cursorMs).toISOString());
    cursorDate = stepScheduleOccurrenceDate(cursorDate, freq);
    cursorMs = zonedWallClockToUtcMs({ ...cursorDate, hour, minute }, tz);
  }

  // Advance to the next strictly future occurrence
  while (cursorMs <= nowMs) {
    cursorDate = stepScheduleOccurrenceDate(cursorDate, freq);
    cursorMs = zonedWallClockToUtcMs({ ...cursorDate, hour, minute }, tz);
  }

  return {
    hasMissed: missedOccurrences.length > 0,
    missedCount: missedOccurrences.length,
    missedOccurrences,
    earliestMissedAt: missedOccurrences[0] || null,
    latestMissedAt: missedOccurrences[missedOccurrences.length - 1] || null,
    nextUpcoming: new Date(cursorMs).toISOString(),
  };
}

export function formatTime12Hour(timeOfDay = "09:00") {
  const { hour, minute } = parseTimeOfDay(timeOfDay);
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatScheduleFrequencyLabel(schedule = {}) {
  const freq = schedule.frequency || SCHEDULE_FREQUENCIES.WEEKLY;
  const dayName = DAY_NAMES[normalizeDayOfWeek(schedule.dayOfWeek)] || "Monday";
  const timeLabel = formatTime12Hour(schedule.timeOfDay || "09:00");
  if (freq === SCHEDULE_FREQUENCIES.DAILY) {
    return `Every day · ${timeLabel}`;
  }
  if (freq === SCHEDULE_FREQUENCIES.BIWEEKLY) {
    return `Every 2nd ${dayName} · ${timeLabel}`;
  }
  return `Every ${dayName} · ${timeLabel}`;
}

