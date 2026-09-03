import { execFile } from "node:child_process";
import { config } from "../config.js";

// After a git task pushes, watch the GitHub Actions runs for the pushed commit
// (router/handler.ts's watchCiAndReport). A failure gets sent to WhatsApp with
// the failing log and an offer to fix it; a pass gets a one-line "CI ijo".
// A repo with no Actions, or one whose runs never finish in time, stays quiet.
// gh reads GITHUB_TOKEN from the environment and infers the repo from origin,
// same as agent/prReview.ts.

const GH_TIMEOUT_MS = 30_000;
const POLL_MS = 20_000;
// How long to keep polling when no run has shown up yet — a push can take a
// while to register a workflow run, but if nothing appears the repo probably
// has no CI for this branch.
const GRACE_MS = 120_000;
const MAX_LOG_CHARS = 4000;

export interface GhRun {
  databaseId: number;
  headSha: string;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | timed_out | ...
  url: string;
  workflowName: string;
}

// Conclusions that mean "CI is red for this commit". A plain `cancelled` isn't
// here on purpose — a run someone cancelled by hand isn't a code failure.
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export type RunState = "none" | "pending" | "success" | "failure";

// Pure decision over a `gh run list` result. `none` = nothing for this sha
// yet (caller decides whether that's "no CI" based on elapsed time);
// `pending` = at least one run still going; otherwise success/failure.
export function classifyRuns(runs: GhRun[], sha: string): { state: RunState; failing: GhRun[] } {
  const matched = runs.filter((r) => r.headSha === sha);
  if (matched.length === 0) return { state: "none", failing: [] };
  if (matched.some((r) => r.status !== "completed")) return { state: "pending", failing: [] };
  const failing = matched.filter((r) => r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion));
  return failing.length > 0 ? { state: "failure", failing } : { state: "success", failing: [] };
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

export interface CiResult {
  state: "success" | "failure" | "none" | "timeout" | "error";
  failing?: { workflowName: string; url: string }[];
  failureLog?: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    // Remove the listener when the timeout wins so a long poll loop doesn't
    // pile up listeners on the shared signal ({once:true} only self-removes on
    // fire).
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Polls `gh run list` until every run for `sha` has finished, then returns the
// verdict (plus the first failing run's log on a failure). Best-effort: any gh
// error short-circuits to `error` and the caller stays silent.
export async function watchCiForSha(params: {
  cwd: string;
  sha: string;
  branch: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<CiResult> {
  const { cwd, sha, branch, signal } = params;
  const timeoutMs = params.timeoutMs ?? config.ciWatch.timeoutMinutes * 60_000;
  const startedAt = Date.now();

  for (;;) {
    if (signal.aborted) return { state: "error" };
    // Scoped to the branch: on a busy repo an unscoped `-L 40` fills with runs
    // from other branches/PRs and the pushed commit's runs fall outside it.
    const list = await gh(cwd, [
      "run",
      "list",
      "-b",
      branch,
      "-L",
      "40",
      "--json",
      "databaseId,headSha,status,conclusion,url,workflowName",
    ]);
    if (!list.ok) return { state: "error" };

    let runs: GhRun[];
    try {
      runs = JSON.parse(list.stdout) as GhRun[];
    } catch {
      return { state: "error" };
    }

    const { state, failing } = classifyRuns(runs, sha);
    if (state === "success") return { state: "success" };
    if (state === "failure") {
      const first = failing[0];
      const log = await gh(cwd, ["run", "view", String(first.databaseId), "--log-failed"]);
      return {
        state: "failure",
        failing: failing.map((r) => ({ workflowName: r.workflowName, url: r.url })),
        failureLog: log.ok ? tailLog(log.stdout) : "(gagal ambil log-nya)",
      };
    }
    // "none" for longer than the grace window -> this branch has no CI.
    if (state === "none" && Date.now() - startedAt > GRACE_MS) return { state: "none" };
    if (Date.now() - startedAt > timeoutMs) return { state: "timeout" };

    await sleep(POLL_MS, signal);
  }
}

function tailLog(s: string, max = MAX_LOG_CHARS): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(-max);
  const nl = slice.indexOf("\n");
  return "…\n" + (nl >= 0 ? slice.slice(nl + 1) : slice);
}
