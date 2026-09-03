// Formats the audit-log trail of a task for the "log task terakhir" command.
// Pure so the wording is tested without a DB.

const MAX_LINES = 40;
const MAX_DETAIL = 110;

export function formatTaskLog(rows: { kind: string; detail: string }[], header: string): string {
  if (rows.length === 0) return `${header}\n\n(gak ada catatan langkahnya)`;

  const shown = rows.slice(-MAX_LINES);
  const lines = shown.map((r) => {
    const d = r.detail.length > MAX_DETAIL ? r.detail.slice(0, MAX_DETAIL) + "…" : r.detail;
    if (r.kind === "error") return `[error] ${d}`;
    if (r.kind === "note") return `— ${d}`;
    return `• ${d}`;
  });
  const trimmed = rows.length > MAX_LINES ? `(${rows.length - MAX_LINES} langkah awal disingkat)\n` : "";
  return `${header}\n\n${trimmed}${lines.join("\n")}`;
}
