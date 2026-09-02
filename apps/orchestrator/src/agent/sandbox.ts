import { execFileSync } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";

// The `bash` tool runs shell commands the model picked. Two independent
// hardening layers, both keyed off config.sandbox.mode (AGENT_SANDBOX):
//
//   1. Environment scrub (always, unless mode is "off"): the child only sees a
//      small allowlist, so `env` / `printenv` / a stray `echo $X` can't hand
//      the model GEMINI_API_KEY, META_ACCESS_TOKEN, INTERNAL_SHARED_SECRET, …
//      GITHUB_TOKEN is deliberately kept — git push / gh read it straight from
//      the environment (git/repo.ts) and the agent does git work.
//
//   2. Filesystem confinement via bubblewrap (Linux only, when `bwrap` is on
//      PATH, mode "auto" or "bwrap"): the task's own workspace is the only
//      writable path, and the orchestrator's repo (its .env) + data dir (its
//      sqlite db, the HF cache) aren't even readable.
//
// Windows/macOS get layer 1 only — bwrap is Linux-only. That's the dev-box vs
// deploy-box split, and it's fine: the box that matters is the Linux server.

type SandboxMode = "auto" | "bwrap" | "none" | "off";
function mode(): SandboxMode {
  return config.sandbox.mode;
}

const ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LANGUAGE",
  "PWD", "TMPDIR", "TEMP", "TMP",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  // The agent does git/gh work and these are read from the environment, not
  // from disk (git/repo.ts's credential helper) — this exposure is intended.
  "GITHUB_TOKEN", "GH_TOKEN",
  // A Windows shell needs these just to start.
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "PROGRAMDATA", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME", "USERDOMAIN",
]);

export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (mode() === "off") return { ...base };
  const keep = new Set([...ENV_ALLOW, ...config.sandbox.keepEnv]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (keep.has(k) || k.startsWith("LC_")) out[k] = v;
  }
  return out;
}

// Resolved once: bwrap has to be both on PATH and actually able to create a
// namespace here. In a stock Docker container unprivileged user namespaces are
// often blocked, so `bwrap` exists but every invocation fails — probing with a
// trivial jail catches that and we fall back to env-scrub-only instead of
// breaking every bash call.
let bwrapProbe: { path: string | undefined } | undefined;
function findBwrap(): string | undefined {
  if (!bwrapProbe) {
    bwrapProbe = { path: probeBwrap() };
  }
  return bwrapProbe.path;
}

function probeBwrap(): string | undefined {
  if (process.platform !== "linux") return undefined;
  let bin: string;
  try {
    bin = execFileSync("which", ["bwrap"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
  if (!bin) return undefined;
  try {
    execFileSync(bin, ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "true"], { stdio: "ignore" });
    return bin;
  } catch {
    console.warn("[sandbox] bwrap is installed but can't create a namespace here — falling back to env scrub only");
    return undefined;
  }
}

export function bwrapActive(): boolean {
  const m = mode();
  if (m === "off" || m === "none") return false;
  return process.platform === "linux" && !!findBwrap();
}

const BASH = process.platform === "win32" ? "bash.exe" : "/bin/bash";

// tmpfs'd on top of an otherwise read-only root so their contents are gone;
// the one active workspace is bound back rw afterward, so a workspace living
// under one of these (the default WORKSPACES_DIR is inside the repo) is fine.
function hiddenPaths(): string[] {
  const set = new Set<string>([config.repoRoot, path.dirname(config.dbPath), config.workspacesDir]);
  const home = process.env.HOME;
  if (home) {
    for (const rel of [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube", ".netrc", ".git-credentials", ".npmrc"]) {
      set.add(path.join(home, rel));
    }
  }
  return [...set];
}

// Pure, exported for tests — order matters: `--ro-bind / /` first, then the
// /dev, /proc, /tmp and hidden-path tmpfs overlays on top of it, then the
// workspace bind on top of everything so it wins.
export function buildBwrapArgs(cwd: string, command: string, hidden: string[] = hiddenPaths()): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ];
  for (const h of hidden) args.push("--tmpfs", h);
  args.push("--bind", cwd, cwd, "--chdir", cwd);
  args.push("--", BASH, "-c", command);
  return args;
}

export interface BashInvocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function bashInvocation(cwd: string, command: string): BashInvocation {
  const env = sandboxEnv();
  if (!bwrapActive()) {
    return { file: BASH, args: ["-c", command], env };
  }
  return { file: findBwrap() as string, args: buildBwrapArgs(cwd, command), env };
}

export function sandboxSummary(): string {
  if (mode() === "off") return "off — no env scrub, no fs confinement";
  if (bwrapActive()) return "bwrap fs-confinement + env scrub";
  if (mode() === "bwrap") return "env scrub only (AGENT_SANDBOX=bwrap set, but bwrap/Linux unavailable)";
  return "env scrub only";
}

// Test-only: forget the cached bwrap probe result.
export function resetBwrapLookupForTests(): void {
  bwrapProbe = undefined;
}
