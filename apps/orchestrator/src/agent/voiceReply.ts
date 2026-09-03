import { pcm16ToMp3, stripForSpeech } from "./tts.js";
import type { Provider } from "./types.js";

// Turns a reply into a speakable MP3 for the opt-in voice-note reply
// (router/handler.ts). Best-effort: no TTS-capable provider, an empty
// speakable string, a provider error, or a bad encode all just return
// undefined and the caller stays silent (the text reply already went out).
export async function synthesizeReply(
  text: string,
  providers: Provider[],
  signal: AbortSignal
): Promise<Buffer | undefined> {
  const speakable = stripForSpeech(text);
  if (!speakable) return undefined;

  const provider = providers.find((p) => p.synthesizeSpeech);
  if (!provider?.synthesizeSpeech) return undefined;

  try {
    const { base64Pcm, sampleRate } = await provider.synthesizeSpeech(speakable, signal);
    const mp3 = pcm16ToMp3(Buffer.from(base64Pcm, "base64"), sampleRate);
    return mp3.length > 0 ? mp3 : undefined;
  } catch (err) {
    console.error("[voice-reply] gagal sintesis:", err instanceof Error ? err.message : err);
    return undefined;
  }
}
