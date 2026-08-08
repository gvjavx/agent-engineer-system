import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAddProject,
  parseUseProject,
  isListProjectsCommand,
  isHelpCommand,
  isStatusCommand,
  isStopCommand,
} from "./parse.js";

test("parseAddProject extracts alias and repo url", () => {
  const result = parseAddProject("tambah project toko-online https://github.com/x/toko-online.git");
  assert.deepEqual(result, {
    alias: "toko-online",
    repoUrl: "https://github.com/x/toko-online.git",
  });
});

test("parseAddProject is case-insensitive and tolerates surrounding whitespace", () => {
  const result = parseAddProject("  TAMBAH Project  demo   https://github.com/x/demo.git  ");
  assert.deepEqual(result, { alias: "demo", repoUrl: "https://github.com/x/demo.git" });
});

test("parseAddProject returns undefined for unrelated text", () => {
  assert.equal(parseAddProject("tambahin fitur login"), undefined);
  assert.equal(parseAddProject("tambah project cuma-satu-kata"), undefined);
});

test("parseUseProject extracts alias from pakai/gunakan", () => {
  assert.equal(parseUseProject("pakai toko-online"), "toko-online");
  assert.equal(parseUseProject("gunakan toko-online"), "toko-online");
  assert.equal(parseUseProject("pakai baju baru"), undefined);
});

test("phrase matchers ignore case and whitespace", () => {
  assert.ok(isListProjectsCommand("  Daftar Project  "));
  assert.ok(isHelpCommand("BANTUAN"));
  assert.ok(isStatusCommand("status"));
  assert.ok(isStopCommand("Batalkan"));
  assert.ok(!isStopCommand("batalkan dong ya"));
});
