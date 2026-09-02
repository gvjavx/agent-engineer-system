import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSchedule, computeNextRun, formatWibInstant, type ScheduleSpec } from "./schedule.js";

// WIB wall-clock parts of an epoch (UTC+7, no DST).
function wibOf(epochMs: number) {
  const d = new Date(epochMs + 7 * 3600_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
// A fixed reference: 2026-09-02 10:00 WIB.
const REF = Date.UTC(2026, 8, 2, 3, 0, 0);

test("parseSchedule reads daily / weekly / monthly / every-N-hours", () => {
  assert.deepEqual(parseSchedule("tiap hari jam 7")?.spec, { kind: "daily", hour: 7, minute: 0 });
  assert.equal(parseSchedule("tiap hari jam 7")?.label, "tiap hari jam 07:00");
  assert.deepEqual(parseSchedule("tiap Senin jam 9:30")?.spec, { kind: "weekly", dow: 1, hour: 9, minute: 30 });
  assert.deepEqual(parseSchedule("tiap tanggal 1")?.spec, { kind: "monthly", day: 1, hour: 8, minute: 0 });
  assert.deepEqual(parseSchedule("tiap 6 jam")?.spec, { kind: "everyHours", n: 6 });
  assert.deepEqual(parseSchedule("tiap jam")?.spec, { kind: "everyHours", n: 1 });
});

test("parseSchedule defaults the time to 08:00 and understands pagi/sore/malam and 'setiap'", () => {
  assert.deepEqual(parseSchedule("tiap hari")?.spec, { kind: "daily", hour: 8, minute: 0 });
  assert.deepEqual(parseSchedule("tiap jumat jam 7 malam")?.spec, { kind: "weekly", dow: 5, hour: 19, minute: 0 });
  assert.deepEqual(parseSchedule("tiap hari jam 1 siang")?.spec, { kind: "daily", hour: 13, minute: 0 });
  assert.deepEqual(parseSchedule("setiap hari jam 6")?.spec, { kind: "daily", hour: 6, minute: 0 });
});

test("parseSchedule rejects malformed or unsupported forms", () => {
  assert.equal(parseSchedule("tiap 5 jam"), undefined); // 5 doesn't divide 24
  assert.equal(parseSchedule("tiap hari jam 25"), undefined);
  assert.equal(parseSchedule("tiap hari jam 8:75"), undefined);
  assert.equal(parseSchedule("besok pagi"), undefined);
  assert.equal(parseSchedule("tiap tanggal 40"), undefined);
});

test("computeNextRun (daily) picks today if the time is still ahead, else tomorrow", () => {
  const soon = computeNextRun({ kind: "daily", hour: 23, minute: 0 }, REF); // 23:00 > 10:00 today
  assert.deepEqual([wibOf(soon).day, wibOf(soon).h], [2, 23]);
  const tomorrow = computeNextRun({ kind: "daily", hour: 7, minute: 0 }, REF); // 07:00 already past
  assert.deepEqual([wibOf(tomorrow).day, wibOf(tomorrow).h], [3, 7]);
  assert.ok(tomorrow > REF && tomorrow - REF <= 24 * 3600_000);
});

test("computeNextRun (weekly) lands on the right weekday, in the future, within a week", () => {
  for (let dow = 0; dow < 7; dow++) {
    const next = computeNextRun({ kind: "weekly", dow, hour: 9, minute: 0 }, REF);
    assert.equal(wibOf(next).dow, dow);
    assert.equal(wibOf(next).h, 9);
    assert.ok(next > REF && next - REF <= 7 * 24 * 3600_000);
  }
});

test("computeNextRun (monthly) hits the target day-of-month and clamps an impossible day", () => {
  const mid = computeNextRun({ kind: "monthly", day: 15, hour: 8, minute: 0 }, REF);
  assert.equal(wibOf(mid).day, 15);
  assert.ok(mid > REF);
  // day 31 from a Feb-ish window clamps to the last day, never rolls into March.
  const febRef = Date.UTC(2026, 1, 1, 0, 0, 0); // 1 Feb 2026 07:00 WIB
  const clamped = computeNextRun({ kind: "monthly", day: 31, hour: 8, minute: 0 }, febRef);
  assert.equal(wibOf(clamped).mo, 1); // still February
  assert.equal(wibOf(clamped).day, 28);
});

test("computeNextRun (everyHours) returns the next aligned top-of-hour", () => {
  const n6 = computeNextRun({ kind: "everyHours", n: 6 }, REF); // 10:00 -> 12:00 WIB
  assert.equal(wibOf(n6).h % 6, 0);
  assert.equal(wibOf(n6).mi, 0);
  assert.ok(n6 > REF && n6 - REF <= 6 * 3600_000);
  const n1 = computeNextRun({ kind: "everyHours", n: 1 }, REF + 90_000); // 10:01:30 -> 11:00
  assert.equal(wibOf(n1).h, 11);
});

test("computeNextRun always returns a strictly future instant", () => {
  const specs: ScheduleSpec[] = [
    { kind: "daily", hour: 10, minute: 0 }, // exactly "now"
    { kind: "weekly", dow: wibOf(REF).dow, hour: 10, minute: 0 },
    { kind: "everyHours", n: 1 },
  ];
  for (const s of specs) assert.ok(computeNextRun(s, REF) > REF, JSON.stringify(s));
});

test("formatWibInstant renders a readable WIB stamp", () => {
  assert.match(formatWibInstant(REF), /^\w+, \d{1,2} \w{3} \d{2}:\d{2} WIB$/);
});
