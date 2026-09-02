import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatNumstat, headSha, summarizeChangesSince } from "./repo.js";

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
