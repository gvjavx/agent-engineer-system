import { execFileSync } from "node:child_process";

// A sanity check on the staged diff right before the agent's `git commit`: if
// a task is about to land far more than it should (runaway generation, a
// rewrite it wasn't asked for), pause for a WhatsApp yes/no. Not a hard gate
// like the secret scan — the user can wave it through.

const COMMIT_ALL_RE = /\bcommit\b[^\n]*?(?:\s-\w*a\w*|\s--all)\b/;

export interface DiffSize {
  files: number;
  added: number;
  removed: number;
}

export function stagedDiffSize(cwd: string, command: string): DiffSize {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return "";
    }
  };
  let raw = run(["diff", "--cached", "--numstat"]);
  if (COMMIT_ALL_RE.test(command)) raw += "\n" + run(["diff", "--numstat"]);

  const seen = new Set<string>();
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || seen.has(m[3])) continue;
    seen.add(m[3]);
    files++;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  return { files, added, removed };
}

export function diffTooBigReason(s: DiffSize, maxFiles: number, maxLines: number): string | undefined {
  if (s.files > maxFiles || s.added + s.removed > maxLines) {
    return `diff-nya kegedean buat satu task — ${s.files} file, +${s.added}/−${s.removed}`;
  }
  return undefined;
}
