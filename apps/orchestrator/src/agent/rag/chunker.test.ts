import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFile, shouldIndexFile } from "./chunker.js";

test("chunkFile splits into overlapping windows with 1-indexed inclusive line numbers", () => {
  const source = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkFile("src/a.ts", source, { lines: 40, overlap: 10 });

  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 40);
  // step = lines - overlap = 30
  assert.equal(chunks[1].startLine, 31);
  assert.equal(chunks[1].endLine, 70);
  assert.equal(chunks[2].startLine, 61);
  assert.equal(chunks[2].endLine, 100);
  assert.equal(chunks[chunks.length - 1].endLine, 100);
});

test("chunkFile prefixes each chunk with a // path:lines header", () => {
  const chunks = chunkFile("src/b.ts", "a\nb\nc", { lines: 60, overlap: 10 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].content.startsWith("// src/b.ts:1-3\n"));
  assert.ok(chunks[0].content.endsWith("a\nb\nc"));
});

test("chunkFile normalizes CRLF and does not report a phantom trailing line", () => {
  const chunks = chunkFile("x.ts", "one\r\ntwo\r\nthree\r\n", { lines: 60, overlap: 10 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
  assert.ok(!chunks[0].content.includes("\r"));
});

test("chunkFile returns nothing for a blank file", () => {
  assert.deepEqual(chunkFile("empty.ts", "   \n\n  \n"), []);
});

test("chunkFile advances even when overlap is passed >= window", () => {
  const source = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const chunks = chunkFile("y.ts", source, { lines: 5, overlap: 99 });
  // overlap is clamped to lines-1 (=4), step 1 — must still terminate and cover the file
  assert.ok(chunks.length > 0);
  assert.equal(chunks[chunks.length - 1].endLine, 20);
});

test("chunkFile splits a TS file at function/class boundaries, not blind windows", () => {
  const src = [
    "import { x } from './x';", // 1
    "", // 2
    "export function alpha() {", // 3
    "  return x + 1;", // 4
    "}", // 5
    "", // 6
    "const beta = async (n: number) => {", // 7
    "  return n * 2;", // 8
    "};", // 9
    "", // 10
    "export class Gamma {", // 11
    "  run() { return 3; }", // 12
    "}", // 13
  ].join("\n");
  // Small window so the merge logic keeps each symbol roughly on its own.
  const chunks = chunkFile("src/mod.ts", src, { lines: 6, overlap: 1 });

  // Every chunk boundary starts on a symbol/header line, never mid-body.
  const starts = chunks.map((c) => c.startLine);
  for (const s of starts) {
    const line = src.split("\n")[s - 1];
    assert.ok(
      s === 1 || /^(export )?(function|class|const)\b/.test(line),
      `chunk starts mid-symbol at line ${s}: "${line}"`
    );
  }
  // The class body isn't cut apart.
  const gamma = chunks.find((c) => c.content.includes("class Gamma"))!;
  assert.ok(gamma.content.includes("run() { return 3; }"));
});

test("chunkFile windows a single oversized symbol instead of emitting one giant chunk", () => {
  const body = Array.from({ length: 50 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  const src = `export function huge() {\n${body}\n}\nexport function tiny() { return 1; }`;
  const chunks = chunkFile("src/big.ts", src, { lines: 20, overlap: 5 });
  // huge() is ~52 lines > 1.5*20 -> it gets windowed into multiple chunks.
  const hugeChunks = chunks.filter((c) => c.startLine <= 52);
  assert.ok(hugeChunks.length >= 2, "oversized function should be windowed");
  assert.equal(chunks[chunks.length - 1].endLine, src.split("\n").length);
});

test("chunkFile falls back to line windows for a language it can't parse", () => {
  const src = Array.from({ length: 30 }, (_, i) => `int v${i} = ${i};`).join("\n");
  const chunks = chunkFile("main.c", src, { lines: 10, overlap: 2 });
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 10);
  assert.equal(chunks[1].startLine, 9); // step = 10 - 2 + 1 offset -> overlapping windows
});

test("shouldIndexFile accepts source files and rejects noise", () => {
  assert.equal(shouldIndexFile("src/index.ts", 1000), true);
  assert.equal(shouldIndexFile("README.md", 1000), true);
  assert.equal(shouldIndexFile("Dockerfile", 1000), true);
  assert.equal(shouldIndexFile("deep/nested/thing.py", 1000), true);

  assert.equal(shouldIndexFile("node_modules/foo/index.js", 10), false);
  assert.equal(shouldIndexFile("dist/bundle.js", 10), false);
  assert.equal(shouldIndexFile("app.min.js", 10), false);
  assert.equal(shouldIndexFile("package-lock.json", 10), false);
  assert.equal(shouldIndexFile("pnpm-lock.yaml", 10), false);
  assert.equal(shouldIndexFile("Cargo.lock", 10), false);
  assert.equal(shouldIndexFile("go.sum", 10), false);
  assert.equal(shouldIndexFile("logo.png", 10), false);
  assert.equal(shouldIndexFile("src/huge.ts", 512 * 1024), false);
  assert.equal(shouldIndexFile("noext", 10), false);
});

test("shouldIndexFile treats backslash paths the same as forward slash", () => {
  assert.equal(shouldIndexFile("node_modules\\pkg\\a.ts", 10), false);
  assert.equal(shouldIndexFile("src\\a.ts", 10), true);
});
