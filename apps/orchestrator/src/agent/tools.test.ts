import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool, detectMilestone, briefToolDescription } from "./tools.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("write_file then read_file round-trips content with line numbers", async () => {
  await withTempDir(async (dir) => {
    const writeResult = await executeTool("write_file", { path: "hello.txt", content: "line one\nline two" }, dir);
    assert.match(writeResult, /Wrote \d+ bytes/);

    const readResult = await executeTool("read_file", { path: "hello.txt" }, dir);
    assert.equal(readResult, "1\tline one\n2\tline two");
  });
});

test("edit_file replaces a unique substring", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "a.txt"), "const x = 1;");
    const result = await executeTool("edit_file", { path: "a.txt", old_string: "x = 1", new_string: "x = 2" }, dir);
    assert.match(result, /Edited a\.txt/);
    const content = await fs.readFile(path.join(dir, "a.txt"), "utf-8");
    assert.equal(content, "const x = 2;");
  });
});

test("edit_file reports an error when old_string is not unique", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "a.txt"), "dup\ndup");
    const result = await executeTool("edit_file", { path: "a.txt", old_string: "dup", new_string: "x" }, dir);
    assert.match(result, /Error: .*appears 2 times/);
  });
});

test("write_file refuses to escape the project directory", async () => {
  await withTempDir(async (dir) => {
    const result = await executeTool("write_file", { path: "../escape.txt", content: "x" }, dir);
    assert.match(result, /Error: .*resolves outside/);
  });
});

test("bash returns stdout and exit code", async () => {
  await withTempDir(async (dir) => {
    const result = await executeTool("bash", { command: "echo hello" }, dir);
    assert.match(result, /exit_code: 0/);
    assert.match(result, /hello/);
  });
});

test("detectMilestone only fires for bash git/test/build commands", () => {
  assert.equal(detectMilestone("bash", { command: "git commit -m x" }), "Commit dibuat");
  assert.equal(detectMilestone("bash", { command: "npm test" }), "Menjalankan test/build");
  assert.equal(detectMilestone("bash", { command: "ls -la" }), undefined);
  assert.equal(detectMilestone("read_file", { path: "a.txt" }), undefined);
});

test("briefToolDescription summarizes each tool kind", () => {
  assert.equal(briefToolDescription("bash", { command: "ls" }), "ls");
  assert.equal(briefToolDescription("write_file", { path: "a.txt" }), "Menulis a.txt");
  assert.equal(briefToolDescription("edit_file", { path: "a.txt" }), "Mengedit a.txt");
  assert.equal(briefToolDescription("read_file", { path: "a.txt" }), "Membaca a.txt");
});
