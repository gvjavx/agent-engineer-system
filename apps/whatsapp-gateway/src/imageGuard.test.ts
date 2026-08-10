import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedInboundImageMimeType } from "./imageGuard.js";

test("isAllowedInboundImageMimeType accepts jpeg and png", () => {
  assert.ok(isAllowedInboundImageMimeType("image/jpeg"));
  assert.ok(isAllowedInboundImageMimeType("image/png"));
});

test("isAllowedInboundImageMimeType rejects other types", () => {
  assert.ok(!isAllowedInboundImageMimeType("image/webp"));
  assert.ok(!isAllowedInboundImageMimeType("image/gif"));
  assert.ok(!isAllowedInboundImageMimeType("application/pdf"));
  assert.ok(!isAllowedInboundImageMimeType(""));
});

test("isAllowedInboundImageMimeType is case-insensitive", () => {
  assert.ok(isAllowedInboundImageMimeType("IMAGE/JPEG"));
  assert.ok(isAllowedInboundImageMimeType("Image/Png"));
});
