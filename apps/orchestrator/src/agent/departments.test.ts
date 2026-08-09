import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDepartment, DEPARTMENT_KEYS, DEPARTMENT_LABELS } from "./departments.js";

test("normalizeDepartment matches canonical keys and aliases", () => {
  assert.equal(normalizeDepartment("dev"), "dev");
  assert.equal(normalizeDepartment("Development"), "dev");
  assert.equal(normalizeDepartment("PRODUK"), "manajemen");
  assert.equal(normalizeDepartment("ux"), "desain");
  assert.equal(normalizeDepartment("devops"), "infra");
  assert.equal(normalizeDepartment("support"), "bisnis");
});

test("normalizeDepartment maps semua/all/default to the 'semua' fallback", () => {
  assert.equal(normalizeDepartment("semua"), "semua");
  assert.equal(normalizeDepartment("all"), "semua");
  assert.equal(normalizeDepartment("Default"), "semua");
});

test("normalizeDepartment returns undefined for unrecognized input", () => {
  assert.equal(normalizeDepartment("gemini"), undefined);
  assert.equal(normalizeDepartment("random-word"), undefined);
});

test("every department key has a label", () => {
  for (const key of DEPARTMENT_KEYS) {
    assert.ok(DEPARTMENT_LABELS[key]?.length > 0, `missing label for ${key}`);
  }
});
