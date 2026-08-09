import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDocumentMimeType } from "./documentGuard.js";

test("resolveDocumentMimeType maps supported extensions", () => {
  assert.equal(resolveDocumentMimeType("FSD.md"), "text/plain");
  assert.equal(resolveDocumentMimeType("report.pdf"), "application/pdf");
  assert.equal(resolveDocumentMimeType("export.zip"), "application/zip");
  assert.equal(resolveDocumentMimeType("sheet.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("resolveDocumentMimeType is case-insensitive on the extension", () => {
  assert.equal(resolveDocumentMimeType("REPORT.PDF"), "application/pdf");
});

test("resolveDocumentMimeType rejects unsupported/dangerous extensions", () => {
  assert.equal(resolveDocumentMimeType("script.sh"), undefined);
  assert.equal(resolveDocumentMimeType("payload.exe"), undefined);
  assert.equal(resolveDocumentMimeType("noextension"), undefined);
});
