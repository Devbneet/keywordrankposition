import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNextRunAt,
  detectMissedOccurrences,
  formatScheduleFrequencyLabel,
  getZonedParts,
  isValidIanaTimezone,
  zonedWallClockToUtcMs,
} from "../modules/scheduler/schedule-calculator.js";
import { SCHEDULE_FREQUENCIES } from "../modules/scheduler/scheduler-state.js";

test("calculateNextRunAt preserves exact local wall-clock time across Australia/Sydney and America/New_York DST transitions", () => {
  assert.equal(isValidIanaTimezone("Australia/Sydney"), true);
  assert.equal(isValidIanaTimezone("Invalid/No_Zone"), false);

  // Australia/Sydney clocks spring forward 2026-10-04 (AEST UTC+10 -> AEDT UTC+11)
  const beforeAusDst = new Date("2026-09-28T05:00:00Z"); // Monday afternoon Sydney
  const nextMonday = calculateNextRunAt({
    dayOfWeek: "Monday",
    timeOfDay: "09:00",
    timezone: "Australia/Sydney",
    frequency: SCHEDULE_FREQUENCIES.WEEKLY,
    afterDate: beforeAusDst,
  });

  // Next Monday is Oct 5, 2026 (first Monday AFTER DST spring-forward!)
  const parts = getZonedParts(nextMonday.utcMs, "Australia/Sydney");
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 10);
  assert.equal(parts.day, 5);
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 0);
  assert.equal(parts.dayOfWeek, 1);

  // Oct 5 09:00 AEDT (UTC+11) === 2026-10-04T22:00:00.000Z (would wrongly be 23:00Z if naive +168h was used!)
  assert.equal(nextMonday.iso, "2026-10-04T22:00:00.000Z");

  // America/New_York clocks fall back 2026-11-01 (EDT UTC-4 -> EST UTC-5)
  const beforeUsFallback = new Date("2026-10-26T16:00:00Z");
  const nyNextMonday = calculateNextRunAt({
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "America/New_York",
    frequency: SCHEDULE_FREQUENCIES.WEEKLY,
    afterDate: beforeUsFallback,
  });
  const nyParts = getZonedParts(nyNextMonday.utcMs, "America/New_York");
  assert.equal(nyParts.year, 2026);
  assert.equal(nyParts.month, 11);
  assert.equal(nyParts.day, 2);
  assert.equal(nyParts.hour, 9);
  assert.equal(nyParts.minute, 0);
  // Nov 2 09:00 EST (UTC-5) === 14:00Z (not 13:00Z!)
  assert.equal(nyNextMonday.iso, "2026-11-02T14:00:00.000Z");
});

test("zonedWallClockToUtcMs safely steps forward past nonexistent spring-forward gap times and biweekly advances by 14 calendar days", () => {
  // 2026-03-08 02:30 America/New_York doesn't exist (01:59 -> 03:00 EDT)
  const ms = zonedWallClockToUtcMs(
    { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
    "America/New_York"
  );
  const resolved = getZonedParts(ms, "America/New_York");
  assert.equal(resolved.month, 3);
  assert.equal(resolved.day, 8);
  assert.equal(resolved.hour, 3);

  const biweekly = calculateNextRunAt({
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "UTC",
    frequency: SCHEDULE_FREQUENCIES.BIWEEKLY,
    afterDate: new Date("2026-11-02T10:00:00.000Z"),
    lastScheduledRunAt: "2026-11-02T09:00:00.000Z",
  });
  assert.equal(biweekly.iso, "2026-11-16T09:00:00.000Z");
});

test("detectMissedOccurrences identifies overdue schedules past grace window and advances nextUpcoming cleanly", () => {
  const sched = {
    scheduleId: "s1",
    enabled: true,
    frequency: SCHEDULE_FREQUENCIES.WEEKLY,
    dayOfWeek: 1,
    timeOfDay: "09:00",
    timezone: "UTC",
    nextScheduledRunAt: "2026-11-02T09:00:00.000Z",
  };

  // Within grace window (5 min late) -> NOT missed yet
  const withinGrace = detectMissedOccurrences({
    schedule: sched,
    now: new Date("2026-11-02T09:05:00.000Z"),
    graceMinutes: 15,
  });
  assert.equal(withinGrace.hasMissed, false);

  // Two Mondays missed (Nov 2 & Nov 9), checking Nov 11
  const twoMissed = detectMissedOccurrences({
    schedule: sched,
    now: new Date("2026-11-11T12:00:00.000Z"),
    graceMinutes: 15,
  });
  assert.equal(twoMissed.hasMissed, true);
  assert.equal(twoMissed.missedCount, 2);
  assert.equal(twoMissed.earliestMissedAt, "2026-11-02T09:00:00.000Z");
  assert.equal(twoMissed.latestMissedAt, "2026-11-09T09:00:00.000Z");
  assert.equal(twoMissed.nextUpcoming, "2026-11-16T09:00:00.000Z");

  assert.equal(formatScheduleFrequencyLabel({ frequency: "weekly", dayOfWeek: 1, timeOfDay: "09:00" }), "Every Monday · 9:00 AM");
});

