import assert from "node:assert/strict";
import { test } from "node:test";
import { pcm16ToMp3, stripForSpeech } from "./tts.js";

test("stripForSpeech drops code, links and markdown, and caps length", () => {
  assert.equal(
    stripForSpeech("Beres. Lihat `src/x.ts` dan https://github.com/o/r/pull/5 buat detail."),
    "Beres. Lihat src/x.ts dan (link) buat detail."
  );
  assert.equal(stripForSpeech("**Selesai** ```js\nconst a=1\n``` semua ijo"), "Selesai semua ijo");
  const long = stripForSpeech("kata ".repeat(400));
  assert.ok(long.length <= 601 && long.endsWith("…"));
});

test("stripForSpeech returns empty when nothing speakable is left", () => {
  assert.equal(stripForSpeech("https://example.com/only-a-link"), "");
  assert.equal(stripForSpeech("*** ---"), "");
});

test("pcm16ToMp3 produces a non-empty MP3 stream (frame sync at the start)", () => {
  // 0.1s of silence at 24kHz mono, 16-bit.
  const pcm = Buffer.alloc(24000 * 2 * 0.1, 0);
  const mp3 = pcm16ToMp3(pcm, 24000);
  assert.ok(mp3.length > 0);
  assert.equal(mp3[0], 0xff);
  assert.equal(mp3[1] & 0xe0, 0xe0); // MPEG frame sync
});
