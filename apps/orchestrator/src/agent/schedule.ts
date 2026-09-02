// Parsing + next-run math for "jadwalkan <kapan>: <instruksi>". Kept pure and
// dependency-free so it's fully unit tested; the DB row, the once-a-minute
// runner and the WhatsApp commands live in db/index.ts and router/handler.ts.
//
// All wall-clock reasoning is in WIB (Asia/Jakarta). Indonesia has no DST, so
// WIB is a fixed UTC+7 and a plain offset is exact — no Intl round-trips.

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dow: number; hour: number; minute: number } // dow: 0=Minggu .. 6=Sabtu (JS getUTCDay convention)
  | { kind: "monthly"; day: number; hour: number; minute: number } // day: 1..31, clamped to the month's length
  | { kind: "everyHours"; n: number }; // n divides 24: 1,2,3,4,6,8,12

export interface ParsedSchedule {
  spec: ScheduleSpec;
  label: string;
}

const DOW_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const DOW_WORDS: Record<string, number> = {
  minggu: 0,
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  "jum'at": 5,
  sabtu: 6,
};
const EVERY_HOURS_ALLOWED = new Set([1, 2, 3, 4, 6, 8, 12]);

function wibParts(epochMs: number) {
  const d = new Date(epochMs + WIB_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    h: d.getUTCHours(),
  };
}

// A WIB wall-clock time (y, 0-based month, day, hour, minute) as a UTC epoch.
function wibWallToEpoch(y: number, mo: number, day: number, hour: number, minute: number): number {
  return Date.UTC(y, mo, day, hour, minute) - WIB_OFFSET_MS;
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// "jam 7", "jam 7:30", "jam 7.30", optionally "pagi/siang/sore/malam".
// Returns [hour, minute] or undefined for a malformed time.
function parseTime(raw: string): [number, number] | undefined {
  const m = raw.match(/jam\s+(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (minute > 59) return undefined;
  if (hour > 23) return undefined;
  if (suffix === "pagi" && hour === 12) hour = 0;
  else if ((suffix === "siang" || suffix === "sore" || suffix === "malam") && hour >= 1 && hour <= 11) hour += 12;
  return [hour, minute];
}

// Undefined -> the caller shows the supported formats.
export function parseSchedule(input: string): ParsedSchedule | undefined {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/^setiap\b/, "tiap");
  const hasTime = /\bjam\s+\d/.test(text);
  const time = hasTime ? parseTime(text) : [8, 0];
  if (!time) return undefined;
  const [hour, minute] = time;

  if (/^tiap jam$/.test(text)) {
    return { spec: { kind: "everyHours", n: 1 }, label: "tiap jam" };
  }
  const everyN = text.match(/^tiap (\d{1,2}) jam$/);
  if (everyN) {
    const n = Number(everyN[1]);
    if (!EVERY_HOURS_ALLOWED.has(n)) return undefined;
    return { spec: { kind: "everyHours", n }, label: `tiap ${n} jam` };
  }

  if (/^tiap hari\b/.test(text)) {
    const spec: ScheduleSpec = { kind: "daily", hour, minute };
    return { spec, label: describeSchedule(spec) };
  }

  const monthly = text.match(/^tiap tanggal (\d{1,2})\b/);
  if (monthly) {
    const day = Number(monthly[1]);
    if (day < 1 || day > 31) return undefined;
    const spec: ScheduleSpec = { kind: "monthly", day, hour, minute };
    return { spec, label: describeSchedule(spec) };
  }

  const dowWord = text.match(/^tiap ([a-z']+)\b/);
  if (dowWord && dowWord[1] in DOW_WORDS) {
    const spec: ScheduleSpec = { kind: "weekly", dow: DOW_WORDS[dowWord[1]], hour, minute };
    return { spec, label: describeSchedule(spec) };
  }

  return undefined;
}

export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "daily":
      return `tiap hari jam ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "weekly":
      return `tiap ${DOW_NAMES[spec.dow]} jam ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "monthly":
      return `tiap tanggal ${spec.day} jam ${pad2(spec.hour)}:${pad2(spec.minute)}`;
    case "everyHours":
      return spec.n === 1 ? "tiap jam" : `tiap ${spec.n} jam`;
  }
}

// Strictly the first fire at or after `afterMs` + 1ms — i.e. always in the
// future relative to `afterMs`. Every branch's loop is bounded (<= ~40 iters).
export function computeNextRun(spec: ScheduleSpec, afterMs: number): number {
  const after = afterMs;

  if (spec.kind === "everyHours") {
    const stepMs = spec.n * HOUR_MS;
    let t = Math.ceil((after + 1) / HOUR_MS) * HOUR_MS; // next top of the hour
    for (let i = 0; i < 24; i++) {
      if (t > after && wibParts(t).h % spec.n === 0) return t;
      t += HOUR_MS;
    }
    return after + stepMs; // unreachable in practice
  }

  const now = wibParts(after);

  if (spec.kind === "daily") {
    let t = wibWallToEpoch(now.y, now.mo, now.day, spec.hour, spec.minute);
    while (t <= after) t += DAY_MS;
    return t;
  }

  if (spec.kind === "weekly") {
    let t = wibWallToEpoch(now.y, now.mo, now.day, spec.hour, spec.minute);
    for (let i = 0; i < 8; i++) {
      if (t > after && wibParts(t).dow === spec.dow) return t;
      t += DAY_MS;
    }
    return t;
  }

  // monthly
  let y = now.y;
  let mo = now.mo;
  for (let i = 0; i < 25; i++) {
    const day = Math.min(spec.day, daysInMonth(y, mo));
    const t = wibWallToEpoch(y, mo, day, spec.hour, spec.minute);
    if (t > after) return t;
    mo += 1;
    if (mo > 11) {
      mo = 0;
      y += 1;
    }
  }
  return after + 28 * DAY_MS; // unreachable
}

// "Rabu, 3 Sep 08:00 WIB" — for confirmations and the schedule list.
export function formatWibInstant(epochMs: number): string {
  const p = wibParts(epochMs);
  const d = new Date(epochMs + WIB_OFFSET_MS);
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return `${DOW_NAMES[p.dow]}, ${p.day} ${months[p.mo]} ${pad2(p.h)}:${pad2(d.getUTCMinutes())} WIB`;
}
