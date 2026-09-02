import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanText, formatSecretHits, scanStagedFiles } from "./secretScan.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretscan-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

const PAT = "github_pat_11ABCDE0000aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("scanText catches a fine-grained GitHub PAT and reports its line", () => {
  const text = [
    "line one",
    'const url = "https://x:github_pat_11ABCDE0000aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@github.com/o/r";',
    "line three",
  ].join("\n");
  const hits = scanText(text, "package.json");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "package.json");
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].rule, /fine-grained PAT/);
});

test("scanText catches classic ghp_, AWS, Google and private-key shapes", () => {
  assert.equal(scanText("token=ghp_" + "a".repeat(36)).length, 1);
  assert.equal(scanText("aws=AKIA" + "ABCDEFGHIJKLMNOP").length, 1);
  assert.equal(scanText("key: AIza" + "a".repeat(35)).length, 1);
  assert.equal(scanText("-----BEGIN OPENSSH PRIVATE KEY-----").length, 1);
});

test("scanText ignores ordinary code and near-miss strings", () => {
  const benign = [
    "const githubToken = process.env.GITHUB_TOKEN;",
    "// ghp_ prefixed tokens are 40 chars total",
    'password: "changeme-to-a-long-random-string"',
    "AKIA is a prefix but AKIA123 is too short",
    "sk-short",
  ].join("\n");
  assert.deepEqual(scanText(benign), []);
});

test("scanStagedFiles flags a secret in a staged file, and only once added", () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, "config.json"), `{ "token": "${PAT}" }\n`);
    assert.deepEqual(scanStagedFiles(dir), [], "unstaged file is not part of the pending commit");

    git(dir, "add", "config.json");
    const hits = scanStagedFiles(dir);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "config.json");
    assert.match(hits[0].rule, /fine-grained PAT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanStagedFiles catches a `git commit -am` secret in a tracked-but-unstaged file", () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, "app.js"), "const x = 1;\n");
    git(dir, "add", "app.js");
    git(dir, "commit", "-qm", "init");

    fs.writeFileSync(path.join(dir, "app.js"), `const x = 1;\nconst key = "${PAT}";\n`);
    assert.deepEqual(scanStagedFiles(dir, "git commit -m wip"), [], "plain commit only sees the index");
    const hits = scanStagedFiles(dir, 'git commit -am "wip"');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSecretHits dedups repeats and caps the list", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ rule: "GitHub personal access token", file: `f${i}.ts`, line: 1 }));
  const out = formatSecretHits(many, 5);
  const lines = out.split("\n");
  assert.equal(lines.length, 6); // 5 shown + the "..." line
  assert.equal(lines[5], "- ...");

  const dupes = [
    { rule: "AWS access key id", file: "a.ts", line: 3 },
    { rule: "AWS access key id", file: "a.ts", line: 3 },
  ];
  assert.equal(formatSecretHits(dupes), "- a.ts:3 — AWS access key id");
});
