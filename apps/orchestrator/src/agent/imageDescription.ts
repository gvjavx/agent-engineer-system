import type { Provider } from "./types.js";

function buildImageDescriptionPrompt(caption: string | undefined): string {
  const base = `Describe this image thoroughly for a software engineer who cannot see it and needs to act on it. Cover, as relevant:
- What kind of image this is (screenshot, UI mockup, error dialog, sketch, diagram, photo, etc.)
- Any visible text, error messages, stack traces, or code — transcribe it verbatim, don't paraphrase
- Layout and UI structure (what elements are where, navigation, buttons, forms)
- Colors, spacing, and visual style, but only if it looks design-relevant, not for e.g. a plain error screenshot
- Anything that looks broken, wrong, or noteworthy

Be factual and complete rather than brief — this description is the only information a downstream engineer will have about the image. Don't add recommendations or next steps, just describe what's there.`;

  if (!caption) return base;
  return `${base}\n\nThe user sent this image with the caption: "${caption}" — pay extra attention to whatever in the image is relevant to that.`;
}

// Tries each provider in order (same fallback-chain order buildProviders
// already returns) since vision support genuinely varies by model, unlike
// text classification which basically always works. Returns undefined only
// if every provider fails or none was given/supports it — the caller decides
// the user-facing message for that, this function has no WhatsApp-copy opinions.
export async function describeImage(
  base64Data: string,
  mimeType: string,
  caption: string | undefined,
  providers: Provider[],
  signal: AbortSignal
): Promise<string | undefined> {
  const prompt = buildImageDescriptionPrompt(caption);
  for (const provider of providers) {
    if (!provider.describeImage) continue;
    try {
      const text = await provider.describeImage(base64Data, mimeType, prompt, signal);
      if (text.trim()) return text.trim();
    } catch {
      // try the next provider
    }
  }
  return undefined;
}
