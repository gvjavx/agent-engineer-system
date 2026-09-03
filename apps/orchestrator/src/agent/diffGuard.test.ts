import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diffTooBigReason, stagedDiffSize } from "./diffGuard.js";

test("diffTooBigReason fires on the file or the line bound", () => {
  assert.equal(diffTooBigReason({ files: 3, added: 40, removed: 5 }, 60, 1500), undefined);
  assert.match(diffTooBigReason({ files: 80, added: 10, removed: 0 }, 60, 1500)!, /80 file/);
  assert.match(diffTooBigReason({ files: 4, added: 1200, removed: 400 }, 60, 1500)!, /\+1200\/−400/);
});

test("stagedDiffSize counts staged files and lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffguard-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    g("add", "-A");
    g("commit", "-qm", "base");

    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
    g("add", "-A");

    const size = stagedDiffSize(dir, "git commit -m x");
    assert.equal(size.files, 2);
    assert.equal(size.added, 3); // +2 in a.txt, +1 in b.txt
    assert.equal(size.removed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
