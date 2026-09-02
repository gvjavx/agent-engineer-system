import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatNumstat, headSha, revertRange, summarizeChangesSince } from "./repo.js";

test("formatNumstat totals the lines and lists the biggest files first", () => {
  const raw = ["4\t1\tsrc/a.ts", "0\t9\tsrc/b.ts", "12\t3\tsrc/c.ts"].join("\n");
  const out = formatNumstat(raw)!;
  assert.match(out, /^3 file berubah, \+16 −13\n/);
  const lines = out.split("\n");
  assert.equal(lines[1], "• src/c.ts (+12 −3)"); // 15 changed
  assert.equal(lines[2], "• src/b.ts (+0 −9)"); // 9 changed
  assert.equal(lines[3], "• src/a.ts (+4 −1)"); // 5 changed
});

test("formatNumstat caps the file list and notes the remainder", () => {
  const raw = Array.from({ length: 11 }, (_, i) => `1\t0\tf${i}.ts`).join("\n");
  const out = formatNumstat(raw, 3)!;
  const lines = out.split("\n");
  assert.equal(lines[0], "11 file berubah, +11 −0");
  assert.equal(lines.length, 5); // header + 3 files + "…+8 file lain"
  assert.equal(lines[4], "…+8 file lain");
});

test("formatNumstat treats binary (-\\t-) files as zero and returns undefined for no changes", () => {
  assert.equal(formatNumstat(""), undefined);
  assert.equal(formatNumstat("\n  \n"), undefined);
  const out = formatNumstat("-\t-\tlogo.png")!;
  assert.equal(out, "1 file berubah, +0 −0\n• logo.png (+0 −0)");
});

test("summarizeChangesSince reports the diff between a base sha and HEAD", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffsum-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    git("add", "a.txt");
    git("commit", "-qm", "base");
    const base = await headSha(dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");
    git("add", "-A");
    git("commit", "-qm", "work");

    const summary = await summarizeChangesSince(dir, base);
    assert.match(summary!, /2 file berubah, \+2 −0/);
    assert.match(summary!, /a\.txt/);
    assert.match(summary!, /b\.txt/);

    assert.equal(await summarizeChangesSince(dir, await headSha(dir)), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revertRange undoes a task's commit range as one new commit and pushes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revert-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const g = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { stdio: "ignore" });
    execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
    for (const [k, v] of [
      ["user.email", "t@t.t"],
      ["user.name", "t"],
      ["commit.gpgsign", "false"],
      ["core.autocrlf", "false"],
    ]) {
      g(work, "config", k, v);
    }

    fs.writeFileSync(path.join(work, "f.txt"), "base\n");
    g(work, "add", "-A");
    g(work, "commit", "-qm", "base");
    g(work, "push", "-q", "origin", "main");
    const base = await headSha(work);

    fs.writeFileSync(path.join(work, "f.txt"), "changed by task\n");
    fs.writeFileSync(path.join(work, "new.txt"), "added by task\n");
    g(work, "add", "-A");
    g(work, "commit", "-qm", "task work");
    g(work, "push", "-q", "origin", "main");
    const result = await headSha(work);

    const res = await revertRange(work, "main", base, result, "revert: task work");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.notEqual(res.head, result);
      assert.equal(fs.readFileSync(path.join(work, "f.txt"), "utf8"), "base\n");
      assert.equal(fs.existsSync(path.join(work, "new.txt")), false);
    }
    const originLog = execFileSync("git", ["-C", origin, "log", "--oneline"], { encoding: "utf8" });
    assert.match(originLog, /revert: task work/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("revertRange reports an error instead of throwing when the range is already reverted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revert-noop-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const g = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { stdio: "ignore" });
    execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
    for (const [k, v] of [
      ["user.email", "t@t.t"],
      ["user.name", "t"],
      ["commit.gpgsign", "false"],
      ["core.autocrlf", "false"],
    ]) {
      g(work, "config", k, v);
    }
    fs.writeFileSync(path.join(work, "f.txt"), "base\n");
    g(work, "add", "-A");
    g(work, "commit", "-qm", "base");
    g(work, "push", "-q", "origin", "main");
    const sha = await headSha(work);

    // Empty range (base == result): nothing to revert.
    const res = await revertRange(work, "main", sha, sha, "revert: nothing");
    assert.equal(res.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
