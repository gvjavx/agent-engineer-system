import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// High-confidence, prefix-anchored credential shapes. A match on one of these
// is almost never a false positive, so the agent's commit is blocked outright
// when one shows up in a staged file (agent/loop.ts), and a freshly
// registered repo that already contains one gets a one-time WhatsApp warning
// (router/handler.ts).
//
// Deliberately NOT here: generic `api_key = "<string>"` heuristics. Those
// false-positive on placeholders, .env.example lines and test fixtures, and a
// gate that cries wolf is a gate people learn to route around. The real
// incident this was built for was a live `github_pat_...` sitting in a
// committed package.json — that shape is caught precisely.

export interface SecretHit {
  rule: string;
  file: string;
  line: number;
}

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "GitHub personal access token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { rule: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { rule: "GitHub OAuth / server token", re: /\bgh[osu]_[A-Za-z0-9]{36}\b/ },
  { rule: "GitHub refresh token", re: /\bghr_[A-Za-z0-9]{36}\b/ },
  { rule: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { rule: "Stripe live secret key", re: /\bsk_live_[0-9A-Za-z]{24,}\b/ },
  { rule: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { rule: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

export function scanText(text: string, file = ""): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { rule, re } of RULES) {
      if (re.test(lines[i])) hits.push({ rule, file, line: i + 1 });
    }
  }
  return hits;
}

const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar", ".tgz",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg",
  ".bin", ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".node", ".wasm", ".lock",
]);
const MAX_FILE_BYTES = 512 * 1024;

function scanOneFile(abs: string, rel: string): SecretHit[] {
  try {
    if (SKIP_EXT.has(path.extname(abs).toLowerCase())) return [];
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return []; // NUL byte -> treat as binary
    return scanText(buf.toString("utf8"), rel);
  } catch {
    return [];
  }
}

function gitLines(cwd: string, args: string[], separator: "\n" | "\0"): string[] {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Files that would go into the agent's pending commit. Staged adds / mods /
// copies / renames always count; `git commit -a` / `-am` also sweeps in
// tracked files modified but not yet staged, so those are scanned too when
// the command carries that flag. The agent's flow is write -> `git add` ->
// `git commit` with nothing in between, so the working-tree copy is what
// ends up committed — cheaper to read than `git show :path` per file, and
// equivalent here.
const COMMIT_ALL_RE = /\bcommit\b[^\n]*?(?:\s-\w*a\w*|\s--all)\b/;

export function scanStagedFiles(cwd: string, command = ""): SecretHit[] {
  const names = new Set(gitLines(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], "\n"));
  if (COMMIT_ALL_RE.test(command)) {
    for (const n of gitLines(cwd, ["diff", "--name-only", "--diff-filter=ACMR"], "\n")) names.add(n);
  }
  return [...names].flatMap((n) => scanOneFile(path.join(cwd, n), n));
}

// Bounded scan of a repo's tracked files for the one-time post-registration
// warning. Caps the file count so a huge repo can't stall registration.
export function scanTrackedFiles(cwd: string, maxFiles = 4000): SecretHit[] {
  const names = gitLines(cwd, ["ls-files", "-z"], "\0").slice(0, maxFiles);
  return names.flatMap((n) => scanOneFile(path.join(cwd, n), n));
}

export function formatSecretHits(hits: SecretHit[], limit = 20): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of hits) {
    const key = `${h.file}:${h.line}:${h.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= limit) {
      lines.push("- ...");
      break;
    }
    lines.push(`- ${h.file}:${h.line} — ${h.rule}`);
  }
  return lines.join("\n");
}
