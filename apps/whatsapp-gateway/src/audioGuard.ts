// Allowlist, same default-deny principle as imageGuard.ts. WhatsApp voice
// notes come as OGG/Opus; the other types cover a forwarded audio file.
const ALLOWED_INBOUND_AUDIO_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

// Meta sometimes tacks on codec params, e.g. "audio/ogg; codecs=opus".
export function normalizeAudioMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

export function isAllowedInboundAudioMimeType(mimeType: string): boolean {
  return ALLOWED_INBOUND_AUDIO_MIME_TYPES.has(normalizeAudioMimeType(mimeType));
}

// Meta's documented inbound audio ceiling — reject before an orchestrator
// round-trip or a transcription call.
export const MAX_INBOUND_AUDIO_BYTES = 16 * 1024 * 1024;
