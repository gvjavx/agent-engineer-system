import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectDevCommand, extractLocalUrl } from "./screenshot.js";

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("detectDevCommand prefers dev, then preview/start, and reads the runner from the lockfile", () => {
  const a = tmpProject({ "package.json": JSON.stringify({ scripts: { build: "x", start: "node s.js", dev: "vite" } }) });
  const b = tmpProject({ "package.json": JSON.stringify({ scripts: { preview: "vite preview" } }), "pnpm-lock.yaml": "" });
  try {
    assert.deepEqual(detectDevCommand(a), { runner: "npm", script: "dev" });
    assert.deepEqual(detectDevCommand(b), { runner: "pnpm", script: "preview" });
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("detectDevCommand returns undefined without a usable script or package.json", () => {
  const a = tmpProject({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
  const b = tmpProject({});
  try {
    assert.equal(detectDevCommand(a), undefined);
    assert.equal(detectDevCommand(b), undefined);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("extractLocalUrl picks the first localhost URL and normalises the host", () => {
  assert.equal(extractLocalUrl("  ➜  Local:   http://localhost:5173/"), "http://127.0.0.1:5173");
  assert.equal(extractLocalUrl("listening on http://0.0.0.0:3000"), "http://127.0.0.1:3000");
  assert.equal(extractLocalUrl("started at http://127.0.0.1:4321/"), "http://127.0.0.1:4321");
  assert.equal(extractLocalUrl("compiled successfully, no url yet"), undefined);
});
