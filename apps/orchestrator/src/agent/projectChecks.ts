import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bashInvocation } from "./sandbox.js";

// A per-project test/lint command that runs right before the agent's own
// `git commit` (agent/loop.ts): a non-zero exit blocks the commit and the
// output goes back to the model to fix, so nothing red gets merged/pushed on
// the autonomy-full path. Same "hard gate, no WhatsApp override" shape as the
// secret scan sitting next to it.

// Stored per column on `projects` (db/index.ts):
//   null  -> never determined; the first task auto-detects and fills it in
//   ""    -> no check (auto-detect found none, or the user turned it off)
//   "cmd" -> run this before every commit
export interface CommitCheckSpec {
  testCmd?: string | null;
  lintCmd?: string | null;
}

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 3000;

// npm writes this as the `test` script for a project that never set one up —
// it exits 1 by design, so treat it as "no test", not a command to run.
const NPM_NO_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

// Guess the commands from package.json so a normal npm/pnpm/yarn project is
// gated without anyone configuring anything. A repo with no package.json (or a
// non-JS stack) auto-detects to no check — set one with "atur cek test <cmd>"
// on WhatsApp. Returns "" for a slot with nothing to run, never null: a
// determined-but-empty value is what stops the caller re-detecting forever.
export function detectProjectChecks(cwd: string): { testCmd: string; lintCmd: string } {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
      scripts = pkg.scripts as Record<string, unknown>;
    }
  } catch {
    // no package.json, or not valid JSON — nothing to detect
  }
  const runner = detectPackageRunner(cwd);
  const testScript = typeof scripts.test === "string" ? scripts.test.trim() : "";
  const lintScript = typeof scripts.lint === "string" ? scripts.lint.trim() : "";
  return {
    testCmd: testScript && testScript !== NPM_NO_TEST_PLACEHOLDER ? `${runner} test` : "",
    lintCmd: lintScript ? `${runner} run lint` : "",
  };
}

function detectPackageRunner(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export interface CheckRun {
  ok: boolean;
  // Which check failed and a tail of its output — handed to the model so it
  // fixes the failure instead of retrying the commit unchanged.
  report: string;
}

// Runs the configured checks (lint first — usually faster, cheaper failures),
// stopping at the first that fails. Returns null when nothing is configured,
// so the caller skips the gate with no cost. Aborts cleanly mid-run.
export async function runProjectChecks(
  cwd: string,
  checks: CommitCheckSpec,
  signal: AbortSignal
): Promise<CheckRun | null> {
  const ordered: { kind: string; cmd: string }[] = [];
  if (checks.lintCmd) ordered.push({ kind: "lint", cmd: checks.lintCmd });
  if (checks.testCmd) ordered.push({ kind: "test", cmd: checks.testCmd });
  if (ordered.length === 0 || signal.aborted) return null;

  for (const { kind, cmd } of ordered) {
    const res = await runOne(cwd, cmd, signal);
    if (signal.aborted) return null;
    if (!res.ok) {
      return {
        ok: false,
        report:
          `Cek ${kind} project ("${cmd}") gagal, exit ${res.exitCode}.\n` +
          `Output (dipotong):\n${tail(res.output)}`,
      };
    }
  }
  return { ok: true, report: "" };
}

function runOne(
  cwd: string,
  command: string,
  signal: AbortSignal
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  // Same env scrub + bubblewrap confinement the `bash` tool runs under — this
  // executes project code (the test suite) at the same trust level.
  const { file, args, env } = bashInvocation(cwd, command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env, signal },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
        resolve({ ok: code === 0, exitCode: code, output: `${stdout}\n${stderr}`.trim() });
      }
    );
  });
}

function tail(s: string, max = OUTPUT_TAIL_CHARS): string {
  if (s.length <= max) return s;
  const slice = s.slice(-max);
  const nl = slice.indexOf("\n");
  return "…\n" + (nl >= 0 ? slice.slice(nl + 1) : slice);
}
