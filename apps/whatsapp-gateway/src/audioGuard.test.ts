import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedInboundAudioMimeType, normalizeAudioMimeType, MAX_INBOUND_AUDIO_BYTES } from "./audioGuard.js";

test("normalizeAudioMimeType strips codec params and lowercases", () => {
  assert.equal(normalizeAudioMimeType("audio/ogg; codecs=opus"), "audio/ogg");
  assert.equal(normalizeAudioMimeType("  AUDIO/MP4 "), "audio/mp4");
});

test("isAllowedInboundAudioMimeType accepts the voice-note type with or without params", () => {
  assert.ok(isAllowedInboundAudioMimeType("audio/ogg"));
  assert.ok(isAllowedInboundAudioMimeType("audio/ogg; codecs=opus"));
  assert.ok(isAllowedInboundAudioMimeType("audio/mpeg"));
  assert.ok(isAllowedInboundAudioMimeType("AUDIO/MP4"));
});

test("isAllowedInboundAudioMimeType rejects non-audio and unknown types", () => {
  assert.ok(!isAllowedInboundAudioMimeType("video/mp4"));
  assert.ok(!isAllowedInboundAudioMimeType("application/octet-stream"));
  assert.ok(!isAllowedInboundAudioMimeType(""));
});

test("MAX_INBOUND_AUDIO_BYTES matches WhatsApp's documented 16MB ceiling", () => {
  assert.equal(MAX_INBOUND_AUDIO_BYTES, 16 * 1024 * 1024);
});
