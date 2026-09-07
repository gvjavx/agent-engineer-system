import { runClassifier, type LocalClassifyOpts } from "./localClassifier.js";
import type { Provider } from "./types.js";

// One classifier call instead of two back-to-back ones (used to be
// classifyCommandIntent -> classifyMessageKind, each its own network
// round-trip to a free-tier provider before the user got any reply at all).
// "chat"/"task" absorb what used to be commandIntent's "none" catch-all
// fanning out into a second call — same end behavior, half the latency.
export const INTENTS = [
  "intro",
  "creator",
  "help",
  "explain",
  "list_projects",
  "list_models",
  "status",
  "stop",
  "connect_figma",
  "session_history",
  "greeting",
  "generate_image",
  "generate_document",
  "chat",
  "task",
] as const;
export type Intent = (typeof INTENTS)[number];

function buildIntentPrompt(text: string): string {
  return `The user sent this WhatsApp message to a coding assistant bot. Decide what it means.

Fixed commands:
intro — asking who/what the bot is, asking it to introduce itself
creator — asking who made/created/developed the bot (NOT asking what the bot is or does — that's intro; this is specifically about who built it)
help — asking specifically for the list of commands, exact command syntax, or a technical usage reference/cheatsheet
explain — asking in general, non-technical, plain language how the bot works, how it helps them, or what happens when they ask it to build/change something (e.g. "jelaskan bagaimana anda membantu saya membuat aplikasi") — NOT asking for specific command syntax, just a conceptual explanation
list_projects — asking to see the list of already-registered projects
list_models — asking to see which AI providers/models are currently configured and usable (NOT asking to search/browse a specific provider's full model catalog — that's a different, unsupported-here request)
status — asking what task is currently running
stop — asking to cancel/stop the currently running task
connect_figma — asking to connect/link a Figma account
session_history — asking what was discussed in a previous conversation/session (e.g. "apa chat kita sebelumnya?", "riwayat obrolan kemarin apa?") — NOT asking about a currently running task's status (that's status)
greeting — a greeting or small-talk opener with no other content (e.g. "halo", "hi", "apa kabar", "selamat pagi") — nothing else being asked yet
generate_image — asking the bot to draw, paint, generate, or make a standalone image, illustration, picture, photo, logo, icon, or artwork as the thing being asked for (e.g. "buatkan gambar pohon", "gambarin kucing lucu", "bikinin logo warung kopi"). The bot generates the picture and sends it back. If the request is about a UI, screen, page, or component that lives inside an app/website, that's task, not this.
generate_document — asking the bot to produce a finished document or office file as the deliverable itself — a report, proposal, letter, spreadsheet, slide deck — or naming a file format to get it in (e.g. "buatkan dokumen laporan penjualan", "bikinin proposal dalam pdf", "buat file excel daftar stok barang", "bikin slide presentasi company profile"). This is a one-off file, not a feature. If the thing being "made" is a page/screen/report/export INSIDE an app or codebase ("buatkan halaman laporan penjualan", "bikin fitur export ke excel"), that's task, not this.

Anything that isn't one of the categories above is one of these two:
chat — general conversation: a question, opinion, comment, or small talk that is NOT asking the bot to build/fix/change anything right now and isn't one of the categories above. This includes hypothetical or meta questions about what the bot would do or how it works (e.g. "kalau saya minta bikin aplikasi dari nol, apa yang bakal kamu lakukan") — these ask ABOUT a process, they are not themselves a request to start one. It also includes asking the bot to look something up or check real-world / live information — weather, news, prices, exchange rates, scores, a definition, general trivia (e.g. "cek cuaca hari ini di Surabaya", "kurs dollar sekarang berapa") — even phrased as an order; the bot answers or says it can't, it does not start a coding task.
task — an instruction or request to build, fix, change, deploy, or otherwise work on the user's own software/code/app/repo, right now, however short or vague (e.g. "tambahin dark mode", "kenapa error terus", "benerin bug di halaman login"), and anything not confidently one of the categories above. "cek"/"check" here means checking the user's own project (e.g. "cek kenapa build gagal"), not looking up outside facts.

A message describing a hypothetical task ("kalau saya minta X", "misalnya saya mau Y") without actually requesting it right now is "chat", not "task". If genuinely unsure between chat and task, prefer task. If genuinely unsure between generate_image / generate_document and task — i.e. the "picture" or "document" might be part of an app — prefer task.

Reply with exactly one line, in exactly this format, nothing else:
INTENT: <key>

Use only these exact keys: ${INTENTS.join(", ")}.

Message: "${text}"`;
}

const INTENT_LINE_RE = new RegExp(`^\\s*intent\\s*:\\s*(${INTENTS.join("|")})\\s*$`, "i");

// Line-by-line, forgiving on purpose — free-tier models don't always follow
// formatting instructions exactly. On any parse miss, runClassifier returns
// the "task" fallback — the fail-closed property that must never regress: an
// unparseable response may never resolve to a fixed command or "chat" and
// skip the real task pipeline.
function parseIntentLine(text: string): { value: Intent } | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(INTENT_LINE_RE);
    if (match) return { value: match[1].toLowerCase() as Intent };
  }
  return undefined;
}

export async function classifyIntent(
  text: string,
  provider: Provider,
  signal: AbortSignal,
  opts?: LocalClassifyOpts
): Promise<Intent> {
  return runClassifier({
    prompt: buildIntentPrompt(text),
    provider,
    signal,
    parse: parseIntentLine,
    fallback: "task",
    opts,
  });
}
