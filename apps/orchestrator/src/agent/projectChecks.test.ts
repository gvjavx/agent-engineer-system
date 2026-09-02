import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectProjectChecks, runProjectChecks } from "./projectChecks.js";

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("detectProjectChecks maps test + lint scripts to the npm runner", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
  });
  try {
    assert.deepEqual(detectProjectChecks(dir), { testCmd: "npm test", lintCmd: "npm run lint" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProjectChecks ignores npm's no-test-specified placeholder", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  });
  try {
    assert.deepEqual(detectProjectChecks(dir), { testCmd: "", lintCmd: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProjectChecks picks the runner from the lockfile", () => {
  const pnpm = tmpProject({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "pnpm-lock.yaml": "",
  });
  const yarn = tmpProject({
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
    "yarn.lock": "",
  });
  try {
    assert.equal(detectProjectChecks(pnpm).testCmd, "pnpm test");
    assert.equal(detectProjectChecks(yarn).lintCmd, "yarn run lint");
  } finally {
    fs.rmSync(pnpm, { recursive: true, force: true });
    fs.rmSync(yarn, { recursive: true, force: true });
  }
});

test("detectProjectChecks returns empty (not null) when there's no package.json", () => {
  const dir = tmpProject({});
  try {
    assert.deepEqual(detectProjectChecks(dir), { testCmd: "", lintCmd: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runProjectChecks is a no-op (returns null) when nothing is configured", async () => {
  assert.equal(await runProjectChecks("/tmp", {}, new AbortController().signal), null);
  assert.equal(
    await runProjectChecks("/tmp", { testCmd: "", lintCmd: null }, new AbortController().signal),
    null
  );
});

test("runProjectChecks bails to null when already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await runProjectChecks("/tmp", { testCmd: "echo hi" }, ac.signal), null);
});
