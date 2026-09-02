import type { Provider } from "./types.js";

// Voice-note transcription. Same fallback-chain shape as
// agent/imageDescription.ts: walk the providers in order, skip any that can't
// take audio, return the first non-empty transcript. Returns undefined only
// when every capable provider failed or none was given — the caller owns the
// user-facing message for that.
export async function transcribeVoiceNote(
  base64Data: string,
  mimeType: string,
  providers: Provider[],
  signal: AbortSignal
): Promise<string | undefined> {
  for (const provider of providers) {
    if (!provider.transcribeAudio) continue;
    try {
      const text = await provider.transcribeAudio(base64Data, mimeType, signal);
      if (text.trim()) return text.trim();
    } catch {
      // try the next provider
    }
  }
  return undefined;
}
