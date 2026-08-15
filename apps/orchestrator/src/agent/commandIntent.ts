import type { Provider } from "./types.js";

// One classifier call instead of two back-to-back ones (used to be
// classifyCommandIntent -> classifyMessageKind, each its own network
// round-trip to a free-tier provider before the user got any reply at all).
// "chat"/"task" absorb what used to be commandIntent's "none" catch-all
// fanning out into a second call — same end behavior, half the latency.
export const INTENTS = [
  "intro",
  "help",
  "explain",
  "list_projects",
  "list_models",
  "status",
  "stop",
  "connect_figma",
  "session_history",
  "greeting",
  "chat",
  "task",
] as const;
export type Intent = (typeof INTENTS)[number];

function buildIntentPrompt(text: string): string {
  return `The user sent this WhatsApp message to a coding assistant bot. Decide what it means.

Fixed commands:
intro — asking who/what the bot is, asking it to introduce itself
help — asking specifically for the list of commands, exact command syntax, or a technical usage reference/cheatsheet
explain — asking in general, non-technical, plain language how the bot works, how it helps them, or what happens when they ask it to build/change something (e.g. "jelaskan bagaimana anda membantu saya membuat aplikasi") — NOT asking for specific command syntax, just a conceptual explanation
list_projects — asking to see the list of already-registered projects
list_models — asking to see which AI providers/models are currently configured and usable (NOT asking to search/browse a specific provider's full model catalog — that's a different, unsupported-here request)
status — asking what task is currently running
stop — asking to cancel/stop the currently running task
connect_figma — asking to connect/link a Figma account
session_history — asking what was discussed in a previous conversation/session (e.g. "apa chat kita sebelumnya?", "riwayat obrolan kemarin apa?") — NOT asking about a currently running task's status (that's status)
greeting — a greeting or small-talk opener with no other content (e.g. "halo", "hi", "apa kabar", "selamat pagi") — nothing else being asked yet

Anything that isn't one of the fixed commands above is one of these two:
chat — general conversation: a question, opinion, comment, or small talk that is NOT asking the bot to build/fix/change anything right now and isn't one of the fixed commands. This includes hypothetical or meta questions about what the bot would do or how it works (e.g. "kalau saya minta bikin aplikasi dari nol, apa yang bakal kamu lakukan") — these ask ABOUT a process, they are not themselves a request to start one.
task — an instruction or request to build, fix, change, deploy, or otherwise work on software/code, right now, however short or vague (e.g. "tambahin dark mode", "kenapa error terus", "benerin bug di halaman login"), and anything not confidently one of the categories above.

A message describing a hypothetical task ("kalau saya minta X", "misalnya saya mau Y") without actually requesting it right now is "chat", not "task". If genuinely unsure between chat and task, prefer task.

Reply with exactly one line, in exactly this format, nothing else:
INTENT: <key>

Use only these exact keys: ${INTENTS.join(", ")}.

Message: "${text}"`;
}

const INTENT_LINE_RE = new RegExp(`^\\s*intent\\s*:\\s*(${INTENTS.join("|")})\\s*$`, "i");

// Line-by-line, forgiving on purpose — free-tier models don't always follow
// formatting instructions exactly. Falls back to "task" (not one of the
// fixed commands, not "chat") on any parse miss — the fail-closed property
// that must never regress: an unparseable response may never resolve to a
// fixed command or "chat" and skip the real task pipeline.
function parseIntentResponse(text: string): Intent {
  for (const line of text.split("\n")) {
    const match = line.match(INTENT_LINE_RE);
    if (match) return match[1].toLowerCase() as Intent;
  }
  return "task";
}

export async function classifyIntent(text: string, provider: Provider, signal: AbortSignal): Promise<Intent> {
  try {
    const response = await provider.chat([{ role: "user", content: buildIntentPrompt(text) }], [], signal);
    if (response.type !== "text") return "task";
    return parseIntentResponse(response.text);
  } catch {
    return "task";
  }
}
