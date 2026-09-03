import { Mp3Encoder } from "@breezystack/lamejs";

// Gemini TTS returns raw signed-16-bit PCM; WhatsApp only takes a handful of
// container formats, of which MP3 (audio/mpeg) is the one with a pure-JS
// encoder (no ffmpeg on the box). lamejs wants Int16Array frames.
export function pcm16ToMp3(pcm: Buffer, sampleRate: number, kbps = 96): Buffer {
  const enc = new Mp3Encoder(1, sampleRate, kbps);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const chunks: Uint8Array[] = [];
  const FRAME = 1152;
  for (let i = 0; i < samples.length; i += FRAME) {
    const block = enc.encodeBuffer(samples.subarray(i, i + FRAME));
    if (block.length) chunks.push(block);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// A spoken reply of a raw WhatsApp message is grating — URLs read out
// character by character, markdown asterisks become "asterisk", a huge task
// summary drones on and burns TTS quota. Flatten to something worth hearing,
// or return "" when there's nothing left worth speaking.
const MAX_SPEECH_CHARS = 600;

export function stripForSpeech(text: string): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/https?:\/\/\S+/g, " (link) ")
    .replace(/[*_#>|]/g, "") // markdown noise
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_SPEECH_CHARS) {
    s = s.slice(0, MAX_SPEECH_CHARS).replace(/\s+\S*$/, "") + "…";
  }
  // Nothing but punctuation / a lone "(link)" isn't worth a voice note.
  return /[A-Za-z0-9À-ɏ]/.test(s.replace(/\(link\)/g, "")) ? s : "";
}
