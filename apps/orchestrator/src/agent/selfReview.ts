import { execFileSync } from "node:child_process";
import type { Provider } from "./types.js";

// Opt-in (config.selfReview): one model pass over the staged diff right before
// the agent's own `git commit`, in the same gate slot as the secret scan and
// the test/lint check. It only surfaces things that make the change unfit to
// commit at all (bugs, left-in debug code, hardcoded secrets, broken syntax),
// and it runs at most once per task — the model can commit again to move past
// it. Fail-open: any error means no gate.

const MAX_DIFF_CHARS = 20_000;
const COMMIT_ALL_RE = /\bcommit\b[^\n]*?(?:\s-\w*a\w*|\s--all)\b/;

function stagedDiff(cwd: string, command: string): string {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  let diff = run(["diff", "--cached"]);
  if (COMMIT_ALL_RE.test(command)) diff += "\n" + run(["diff"]);
  return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n…(dipotong)" : diff;
}

export function buildSelfReviewPrompt(diff: string): string {
  return `Kamu reviewer terakhir sebelum commit ini masuk. Ini diff yang mau di-commit:

\`\`\`diff
${diff}
\`\`\`

Sebutin CUMA masalah yang bikin ini nggak layak di-commit apa adanya — bug logika, kode debug ketinggalan (console.log/debugger/print/dump), kredensial ke-hardcode, syntax yang kelihatan rusak, file kepencet jadi kosong/kehapus. Bukan soal gaya, bukan preferensi, bukan saran perbaikan opsional.
Tiap masalah satu baris, diawali "BLOCK: ". Kalau nggak ada, tulis persis "BLOCK: none".`;
}

// Pull the "BLOCK: ..." lines out of the model's reply, dropping the "none"
// sentinel. Tolerant of extra prose around them.
export function parseBlockingLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^block:/i.test(l))
    .map((l) => l.replace(/^block:\s*/i, "").trim())
    .filter((l) => l.length > 0 && l.toLowerCase() !== "none");
}

export async function reviewStagedDiff(
  cwd: string,
  command: string,
  provider: Provider,
  signal: AbortSignal
): Promise<string[]> {
  try {
    const diff = stagedDiff(cwd, command);
    if (!diff.trim()) return [];
    const res = await provider.chat([{ role: "user", content: buildSelfReviewPrompt(diff) }], [], signal);
    return res.type === "text" ? parseBlockingLines(res.text) : [];
  } catch {
    return [];
  }
}
