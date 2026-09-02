// The once-a-day summary text (router/handler.ts's runDailyDigest gathers the
// inputs; this just formats). Pure so the wording is unit-tested without a DB.

export interface DigestInput {
  dateLabel: string;
  finished: { project: string; status: string; instruction: string; reason: string | null }[];
  dueSchedules: { project: string; schedule: string; instruction: string }[];
  cooling: string[];
  usage: { providerId: string; calls: number }[];
}

function oneLine(s: string, max = 120): string {
  const first = s.split("\n")[0].trim();
  return first.length > max ? first.slice(0, max) + "…" : first;
}

export function buildDigestText(d: DigestInput): string {
  const out: string[] = [`Ringkasan harian — ${d.dateLabel}`];

  const done = d.finished.filter((t) => t.status === "done").length;
  const failed = d.finished.filter((t) => t.status === "failed");
  const cancelled = d.finished.filter((t) => t.status === "cancelled").length;

  out.push(
    "",
    d.finished.length === 0
      ? "Task 24 jam: nggak ada."
      : `Task 24 jam: ${done} selesai, ${failed.length} gagal, ${cancelled} batal.`
  );

  if (failed.length) {
    out.push("", "Yang gagal:");
    for (const t of failed.slice(0, 10)) {
      out.push(`- [${t.project}] "${oneLine(t.instruction)}"${t.reason ? ` — ${oneLine(t.reason)}` : ""}`);
    }
  }

  if (d.dueSchedules.length) {
    out.push("", "Jadwal yang bakal jalan hari ini:");
    for (const s of d.dueSchedules.slice(0, 10)) {
      out.push(`- [${s.project}] ${s.schedule}: "${oneLine(s.instruction)}"`);
    }
  }

  if (d.usage.length) {
    out.push("", `Panggilan AI kemarin: ${d.usage.slice(0, 5).map((u) => `${u.providerId} ${u.calls}x`).join(", ")}`);
  }
  if (d.cooling.length) {
    out.push(`Provider lagi cooldown: ${d.cooling.join(", ")}`);
  }

  return out.join("\n");
}
