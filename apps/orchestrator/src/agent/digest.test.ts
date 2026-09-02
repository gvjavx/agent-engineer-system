import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigestText } from "./digest.js";

test("buildDigestText: counts, failures, schedules and provider lines", () => {
  const text = buildDigestText({
    dateLabel: "2026-09-03",
    finished: [
      { project: "shop", status: "done", instruction: "add cart", reason: null },
      { project: "shop", status: "done", instruction: "fix nav", reason: null },
      { project: "api", status: "failed", instruction: "bump deps", reason: "npm test gagal\nline 2" },
      { project: "api", status: "cancelled", instruction: "x", reason: null },
    ],
    dueSchedules: [{ project: "shop", schedule: "tiap hari jam 07:00", instruction: "update deps" }],
    cooling: ["gemini@m#ab"],
    usage: [{ providerId: "gemini@m#ab", calls: 210 }],
  });
  assert.match(text, /Ringkasan harian — 2026-09-03/);
  assert.match(text, /Task 24 jam: 2 selesai, 1 gagal, 1 batal\./);
  assert.match(text, /- \[api\] "bump deps" — npm test gagal/);
  assert.doesNotMatch(text, /line 2/); // reason clipped to first line
  assert.match(text, /Jadwal yang bakal jalan hari ini:/);
  assert.match(text, /- \[shop\] tiap hari jam 07:00: "update deps"/);
  assert.match(text, /Panggilan AI kemarin: gemini@m#ab 210x/);
  assert.match(text, /Provider lagi cooldown: gemini@m#ab/);
});

test("buildDigestText: quiet day", () => {
  const text = buildDigestText({ dateLabel: "2026-09-03", finished: [], dueSchedules: [], cooling: [], usage: [] });
  assert.match(text, /Task 24 jam: nggak ada\./);
  assert.doesNotMatch(text, /Yang gagal/);
  assert.doesNotMatch(text, /Jadwal yang bakal/);
});
