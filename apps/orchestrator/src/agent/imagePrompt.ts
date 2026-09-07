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

// A short modifier phrase that only makes sense as a change to a picture just
// made — "lebih gelap", "bikin yang lebih cerah", "tambahin pohon", "ganti
// warnanya jadi biru". Used to route it back to image generation instead of
// letting the intent classifier read "gelap" as dark mode.
const IMAGE_TWEAK_RE =
  /^\s*(tolong\s+|coba\s+)?(bikin(in)?|buat(in)?)?\s*(yang\s+|biar\s+|jadi\s+)?(lebih|kurang(in)?|tanpa|pakai|pake|ganti|ubah|tambah(in|kan)?|hapus|buang|ilangin|jadiin|jadikan|warnany?a?|background|latar|gayanya|style-?nya|angle|sudut|zoom|crop|fokus(in)?)\b/i;
// "tambahin ..." / "ganti ..." also open coding tasks; if the phrase names an
// app/code thing it isn't a picture tweak.
const CODE_WORD_RE = /\b(fitur|halaman|aplikasi|aplikasinya|website|web|app|endpoint|api|bug|error|login|logout|database|db|button|tombol|form|menu|nav|route|komponen|deploy|commit|repo|branch)\b/i;

export function isImageTweak(message: string): boolean {
  return (
    message.split(/\s+/).filter(Boolean).length <= 12 &&
    IMAGE_TWEAK_RE.test(message) &&
    !CODE_WORD_RE.test(message)
  );
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
