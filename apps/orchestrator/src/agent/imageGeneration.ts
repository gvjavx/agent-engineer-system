import type { Provider } from "./types.js";

export type ImageResult =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; error: string };

// "buatkan gambar ..." — walk the providers in order, skip any that can't
// output images, return the first result. On failure the reason from each
// capable provider is joined into `error` so the caller can put it in the
// WhatsApp reply — image-gen depends entirely on what Google allows the key,
// and there's no other way for the user to see why it failed.
export async function generateImageFromPrompt(
  prompt: string,
  providers: Provider[],
  signal: AbortSignal
): Promise<ImageResult> {
  const errors: string[] = [];
  for (const provider of providers) {
    if (!provider.generateImage) continue;
    try {
      const image = await provider.generateImage(prompt, signal);
      if (image.base64) return { ok: true, base64: image.base64, mimeType: image.mimeType };
      errors.push(`${provider.name}: respons kosong`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[image-gen] ${provider.name} failed:`, message);
      errors.push(`${provider.name}: ${message}`);
    }
  }
  if (errors.length === 0) return { ok: false, error: "gak ada model yang bisa bikin gambar di chat ini" };
  return { ok: false, error: errors.join(" | ").slice(0, 600) };
}
