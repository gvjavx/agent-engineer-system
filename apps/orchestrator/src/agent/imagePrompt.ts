import type { Provider } from "./types.js";

// flux-1-schnell (and image models generally) are trained on English captions
// and get thrown off by instruction words — "buatkan gambar pohon" gives a
// worse result than "a lone tree in a field, natural light". So before
// generating, turn the user's request into a proper English image prompt.

const INSTRUCTION_PREFIX_RE =
  /^\s*(tolong\s+|coba\s+|please\s+)?(buat(kan|in)?|bikin(in|kan)?|gambar(kan|in)?|lukis(kan|in)?|generate|create|draw|make)\s+(aku\s+|saya\s+|me\s+|a\s+|an\s+)?(sebuah\s+|satu\s+)?(gambar|ilustrasi|foto|lukisan|logo|ikon|sketsa|image|picture|drawing|illustration|photo)?(\s+(dari|tentang|of|yang|berupa|:|,))?\s*/i;

// Best-effort strip of the leading "buatkan gambar ..." so at least the
// subject survives when the model call can't run.
export function stripImageInstruction(request: string): string {
  const stripped = request.replace(INSTRUCTION_PREFIX_RE, "").trim();
  return stripped || request.trim();
}

function buildPrompt(request: string, previousPrompt?: string): string {
  if (previousPrompt) {
    return `A previous image was generated from this prompt:
"${previousPrompt}"

The user now wants this change: "${request}"

Output one updated English text-to-image prompt that keeps everything from the previous one except what the change asks to alter. Concise — at most ~40 words. No quotes, no explanation, output only the prompt.`;
  }
  return `Turn this image request into a single English text-to-image prompt: describe the subject, then style, composition, and lighting. Concise — at most ~40 words. No quotes, no explanation, output only the prompt itself.

Request: "${request}"`;
}

// Never throws — on any model failure it falls back to the stripped request
// (or, for a tweak, the previous prompt plus the stripped tweak), still better
// than sending the raw instruction to the image model.
export async function refineImagePrompt(
  request: string,
  provider: Provider | undefined,
  signal: AbortSignal,
  previousPrompt?: string
): Promise<string> {
  const stripped = stripImageInstruction(request);
  const fallback = previousPrompt ? `${previousPrompt}, ${stripped}` : stripped;
  if (!provider) return fallback;
  try {
    const response = await provider.chat([{ role: "user", content: buildPrompt(request, previousPrompt) }], [], signal);
    if (response.type !== "text") return fallback;
    const refined = response.text.trim().replace(/^["'`]|["'`]$/g, "").trim();
    return refined || fallback;
  } catch {
    return fallback;
  }
}
