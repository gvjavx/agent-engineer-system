import { execFile } from "node:child_process";

// "kerjain issue #N" (router/parse.ts's parseWorkIssue): pull the issue's
// title/body/comments with `gh` in the project's workspace and turn them into
// a normal task instruction that runs through the usual classify → confirm →
// pipeline flow. gh reads GITHUB_TOKEN from the environment and infers the
// repo from origin, same as agent/prReview.ts.

const GH_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 6000;
const MAX_COMMENT_CHARS = 800;
const MAX_COMMENTS = 6;

export interface IssueContext {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  comments: { author: string; body: string }[];
}

function gh(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
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

function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : t.slice(0, max) + "\n…(dipotong)";
}

export async function gatherIssueContext(cwd: string, number: number): Promise<IssueContext | { error: string }> {
  const view = await gh(cwd, ["issue", "view", String(number), "--json", "number,title,body,state,labels,url,comments"]);
  if (!view.ok) return { error: view.error };

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(view.stdout);
  } catch {
    return { error: "output gh nggak kebaca" };
  }

  const rawComments = Array.isArray(meta.comments) ? (meta.comments as Record<string, unknown>[]) : [];
  return {
    number,
    title: (meta.title as string) || "(tanpa judul)",
    body: clip((meta.body as string) ?? "", MAX_BODY_CHARS),
    state: (meta.state as string) ?? "?",
    labels: Array.isArray(meta.labels)
      ? (meta.labels as { name?: string }[]).map((l) => l.name ?? "").filter(Boolean)
      : [],
    url: (meta.url as string) ?? "",
    comments: rawComments.slice(-MAX_COMMENTS).map((c) => ({
      author: (c.author as { login?: string } | undefined)?.login ?? "?",
      body: clip((c.body as string) ?? "", MAX_COMMENT_CHARS),
    })),
  };
}

export function buildIssueInstruction(ctx: IssueContext): string {
  const labels = ctx.labels.length ? `\nLabel: ${ctx.labels.join(", ")}` : "";
  const body = ctx.body ? `\n\n${ctx.body}` : "\n\n(deskripsi issue-nya kosong — simpulin sendiri yang paling masuk akal)";
  const comments = ctx.comments.length
    ? `\n\nKomentar di issue (mungkin ada klarifikasi):\n${ctx.comments.map((c) => `- ${c.author}: ${c.body}`).join("\n")}`
    : "";
  return (
    `Kerjain GitHub issue #${ctx.number}: "${ctx.title}"${labels}${body}${comments}\n\n` +
    `Pas commit (dan di deskripsi PR kalau project ini lewat PR), sebutin "Closes #${ctx.number}" biar issue-nya ke-link dan ketutup otomatis pas ke-merge.`
  );
}
