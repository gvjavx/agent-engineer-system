import { execFile } from "node:child_process";
import type { Provider } from "./types.js";

// "review PR #N" (router/parse.ts's parseReviewPr): pull the PR's metadata and
// diff with `gh` in the project's workspace, ask a provider for a plain review,
// and — only if the user then confirms — post it back as a PR comment. No
// checkout, no branch, no pipeline: it's a read + one model call.

const GH_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 24_000;

export interface PrContext {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  diff: string;
  diffTruncated: boolean;
}

function gh(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    // gh reads GITHUB_TOKEN straight from the environment (same var git/repo.ts's
    // credential helper uses) and infers the repo from origin in cwd.
    execFile("gh", args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim().split("\n").slice(0, 3).join(" ");
        resolve({ ok: false, error: msg || "gagal jalanin gh" });
      } else {
        resolve({ ok: true, stdout });
      }
    });
  });
}

// Cut on a line boundary so the model never sees half a hunk.
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
  if (diff.length <= max) return { text: diff, truncated: false };
  const slice = diff.slice(0, max);
  const lastNl = slice.lastIndexOf("\n");
  return { text: slice.slice(0, lastNl > 0 ? lastNl : max), truncated: true };
}

export async function gatherPrContext(cwd: string, number: number): Promise<PrContext | { error: string }> {
  const view = await gh(cwd, [
    "pr",
    "view",
    String(number),
    "--json",
    "title,body,author,state,additions,deletions,changedFiles,url",
  ]);
  if (!view.ok) return { error: view.error };

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(view.stdout);
  } catch {
    return { error: "output gh nggak kebaca" };
  }

  const diffRes = await gh(cwd, ["pr", "diff", String(number)]);
  if (!diffRes.ok) return { error: diffRes.error };
  const { text: diff, truncated } = truncateDiff(diffRes.stdout);

  const author = (meta.author as { login?: string } | undefined)?.login ?? "?";
  return {
    number,
    title: (meta.title as string) || "(tanpa judul)",
    body: ((meta.body as string) ?? "").trim(),
    author,
    state: (meta.state as string) ?? "?",
    additions: (meta.additions as number) ?? 0,
    deletions: (meta.deletions as number) ?? 0,
    changedFiles: (meta.changedFiles as number) ?? 0,
    url: (meta.url as string) ?? "",
    diff,
    diffTruncated: truncated,
  };
}

export function buildReviewPrompt(ctx: PrContext): string {
  const header = `Judul: ${ctx.title}\nAuthor: ${ctx.author} · status: ${ctx.state} · ${ctx.changedFiles} file, +${ctx.additions}/-${ctx.deletions}`;
  const body = ctx.body ? `\n\nDeskripsi PR:\n${ctx.body}` : "";
  const cut = ctx.diffTruncated ? "\n\n(diff dipotong karena kepanjangan — review bagian yang kelihatan aja)" : "";
  return `Kamu reviewer kode senior. Review pull request di bawah ini.

${header}${body}${cut}

Diff:
\`\`\`diff
${ctx.diff}
\`\`\`

Kasih review to the point, Bahasa Indonesia kasual:
- 1-2 kalimat: PR ini ngapain, overall oke atau nggak.
- Temuan konkret kalau ada — bug, edge case kelewat, lubang keamanan, style yang nyimpang jauh. Sebut file/baris kalau bisa. Skip nitpick remeh.
- Kalau ada yang wajib dibenerin sebelum merge, bilang jelas. Kalau udah beres, bilang aman.
Jangan puji berlebihan, jangan ulang isi diff baris per baris, jangan pakai heading markdown.`;
}

export async function reviewPr(ctx: PrContext, provider: Provider, signal: AbortSignal): Promise<string | undefined> {
  try {
    const res = await provider.chat([{ role: "user", content: buildReviewPrompt(ctx) }], [], signal);
    if (res.type !== "text") return undefined;
    const text = res.text.trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function postPrComment(
  cwd: string,
  number: number,
  body: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await gh(cwd, ["pr", "comment", String(number), "--body", body]);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
