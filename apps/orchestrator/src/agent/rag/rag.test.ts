import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cosineSimilarity,
  indexProject,
  retrieveCodeContext,
  type EmbeddingProvider,
} from "./index.js";
import type { RagStore, StoredChunk, RetrievalRow, IndexMeta } from "../../db/rag.js";

// Deterministic stand-in for the real embedder: each dimension counts one
// keyword, so a query and a chunk that share keywords score high.
const KEYWORDS = ["alpha", "beta", "gamma", "delta", "auth", "login", "user", "test"];

function fakeEmbedder(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    name: "fake",
    identity: "fake-embed-1@8",
    async embed(texts) {
      return texts.map((t) => {
        const lower = t.toLowerCase();
        return Float32Array.from(KEYWORDS.map((k) => (lower.match(new RegExp(k, "g")) ?? []).length));
      });
    },
    ...overrides,
  };
}

function memoryStore(): RagStore {
  const files = new Map<string, string>(); // `${alias}\0${path}` -> hash
  const chunks = new Map<string, StoredChunk[]>(); // `${alias}\0${path}` -> chunks
  const meta = new Map<string, IndexMeta>();
  const key = (a: string, p: string) => `${a}\0${p}`;

  return {
    fileHashes(alias) {
      const out = new Map<string, string>();
      for (const [k, hash] of files) {
        const [a, p] = k.split("\0");
        if (a === alias) out.set(p, hash);
      }
      return out;
    },
    replaceFile(alias, filePath, fileHash, cs) {
      files.set(key(alias, filePath), fileHash);
      chunks.set(key(alias, filePath), cs);
    },
    deleteFile(alias, filePath) {
      files.delete(key(alias, filePath));
      chunks.delete(key(alias, filePath));
    },
    deleteProject(alias) {
      for (const k of [...files.keys()]) if (k.startsWith(`${alias}\0`)) files.delete(k);
      for (const k of [...chunks.keys()]) if (k.startsWith(`${alias}\0`)) chunks.delete(k);
      meta.delete(alias);
    },
    allForRetrieval(alias) {
      const rows: RetrievalRow[] = [];
      for (const [k, cs] of chunks) {
        if (!k.startsWith(`${alias}\0`)) continue;
        for (const c of cs) {
          rows.push({
            filePath: c.filePath,
            startLine: c.startLine,
            endLine: c.endLine,
            content: c.content,
            embedding: c.embedding,
          });
        }
      }
      return rows;
    },
    getMeta(alias) {
      return meta.get(alias);
    },
    setMeta(alias, headCommit, embedModel) {
      meta.set(alias, { headCommit, embedModel });
    },
  };
}

test("cosineSimilarity: identical vectors score 1, orthogonal score 0, mismatched length score 0", () => {
  const a = Float32Array.from([1, 2, 3]);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6);
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosineSimilarity(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2])), 0);
});

test("retrieveCodeContext returns undefined when no embedder is configured", async () => {
  const result = await retrieveCodeContext({
    projectAlias: "demo",
    query: "auth login",
    signal: new AbortController().signal,
    deps: { store: memoryStore(), embedder: null },
  });
  assert.equal(result, undefined);
});

test("retrieveCodeContext returns undefined when the index is empty", async () => {
  const result = await retrieveCodeContext({
    projectAlias: "demo",
    query: "auth login",
    signal: new AbortController().signal,
    deps: { store: memoryStore(), embedder: fakeEmbedder() },
  });
  assert.equal(result, undefined);
});

test("retrieveCodeContext ranks by similarity and returns a header + path:line blocks", async () => {
  const store = memoryStore();
  const embedder = fakeEmbedder();
  const [authVec, userVec, betaVec] = await embedder.embed(["auth login auth", "user profile", "beta gamma"]);
  store.replaceFile("demo", "src/auth.ts", "h1", [
    { filePath: "src/auth.ts", startLine: 1, endLine: 20, content: "// src/auth.ts:1-20\nauth login auth", embedding: authVec },
  ]);
  store.replaceFile("demo", "src/user.ts", "h2", [
    { filePath: "src/user.ts", startLine: 1, endLine: 20, content: "// src/user.ts:1-20\nuser profile", embedding: userVec },
  ]);
  store.replaceFile("demo", "src/misc.ts", "h3", [
    { filePath: "src/misc.ts", startLine: 1, endLine: 20, content: "// src/misc.ts:1-20\nbeta gamma", embedding: betaVec },
  ]);

  const result = await retrieveCodeContext({
    projectAlias: "demo",
    query: "auth login user",
    signal: new AbortController().signal,
    deps: { store, embedder },
  });

  assert.ok(result);
  assert.match(result, /Relevant existing code/);
  assert.match(result, /--- src\/auth\.ts:1-20 ---/);
  // the chunker's "// path:lines" prefix line is stripped from the shown body
  // (the "--- path ---" header already carries it)
  assert.doesNotMatch(result, /^\/\/ src\/auth\.ts:1-20$/m);
  assert.match(result, /^auth login auth$/m);
  // "beta gamma" chunk shares nothing with the query — zero similarity, dropped
  assert.doesNotMatch(result, /misc\.ts/);
  // both hits present, best match first
  assert.ok(result.includes("src/user.ts"));
  assert.ok(result.indexOf("src/auth.ts") < result.indexOf("src/user.ts"));
});

test("retrieveCodeContext swallows an embedder failure and returns undefined", async () => {
  const store = memoryStore();
  store.replaceFile("demo", "a.ts", "h", [
    { filePath: "a.ts", startLine: 1, endLine: 1, content: "x", embedding: Float32Array.from([1]) },
  ]);
  const boom = fakeEmbedder({
    async embed() {
      throw new Error("quota exhausted");
    },
  });

  const result = await retrieveCodeContext({
    projectAlias: "demo",
    query: "anything",
    signal: new AbortController().signal,
    deps: { store, embedder: boom },
  });
  assert.equal(result, undefined);
});

test("indexProject skips entirely when RAG has no embedder", async () => {
  const res = await indexProject({
    projectAlias: "demo",
    cwd: "/does/not/matter",
    mode: "local",
    signal: new AbortController().signal,
    deps: { store: memoryStore(), embedder: null },
  });
  assert.equal(res.skipped, true);
  assert.equal(res.filesIndexed, 0);
});

test("indexProject indexes a local folder, then no-ops until a file changes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-index-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, "auth.ts"), "export function login() { return 'auth login'; }\n");
  await fs.mkdir(path.join(dir, "sub"), { recursive: true });
  await fs.writeFile(path.join(dir, "sub", "user.ts"), "export const user = 'user';\n");
  await fs.writeFile(path.join(dir, "logo.png"), "binary-ish");
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const store = memoryStore();
  const embedder = fakeEmbedder();
  const base = { projectAlias: "demo", cwd: dir, mode: "local" as const, signal: new AbortController().signal };

  const first = await indexProject({ ...base, deps: { store, embedder } });
  assert.equal(first.skipped, false);
  assert.equal(first.filesIndexed, 2); // auth.ts + sub/user.ts, not the png or node_modules
  assert.ok(store.allForRetrieval("demo").length >= 2);

  const second = await indexProject({ ...base, deps: { store, embedder } });
  assert.equal(second.filesIndexed, 0);
  assert.equal(second.filesRemoved, 0);

  await fs.writeFile(path.join(dir, "auth.ts"), "export function login() { return 'auth login auth'; }\n");
  const third = await indexProject({ ...base, deps: { store, embedder } });
  assert.equal(third.filesIndexed, 1);

  await fs.rm(path.join(dir, "sub", "user.ts"));
  const fourth = await indexProject({ ...base, deps: { store, embedder } });
  assert.equal(fourth.filesRemoved, 1);
  assert.ok(!store.fileHashes("demo").has("sub/user.ts"));
});

test("indexProject wipes and rebuilds when the embed identity changed (model or dimensionality)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-model-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "a.ts"), "alpha beta gamma\n");

  const store = memoryStore();
  const base = { projectAlias: "demo", cwd: dir, mode: "local" as const, signal: new AbortController().signal };

  await indexProject({ ...base, deps: { store, embedder: fakeEmbedder({ identity: "old-model@768" }) } });
  assert.equal(store.getMeta("demo")?.embedModel, "old-model@768");

  // same model name, different dimensionality -> still a full rebuild
  const rebuilt = await indexProject({ ...base, deps: { store, embedder: fakeEmbedder({ identity: "old-model@1536" }) } });
  assert.equal(rebuilt.skipped, false);
  assert.equal(rebuilt.filesIndexed, 1);
  assert.equal(store.getMeta("demo")?.embedModel, "old-model@1536");
});
