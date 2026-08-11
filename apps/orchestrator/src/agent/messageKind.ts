import type { Provider } from "./types.js";

// Runs after commandIntent.ts's 9 fixed commands have all missed — decides
// whether what's left is an actual coding/dev task, or just conversation
// that deserves a real reply instead of being forced into department
// classification. Fails closed to "task": every failure mode below preserves
// today's pre-existing behavior (treat it as a task) rather than risking a
// real task getting swallowed as small talk.
export const MESSAGE_KINDS = ["task", "chat"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

function buildMessageKindPrompt(text: string): string {
  return `The user sent this WhatsApp message to a coding assistant bot that can build, fix, or change software on their behalf. Decide what kind of message this is.

Reply with exactly one line, in exactly this format, nothing else:
KIND: <key>

Use only these exact keys:
task — an instruction or request to build, fix, change, deploy, or otherwise work on software/code, right now, however short or vague (e.g. "tambahin dark mode", "kenapa error terus", "benerin bug di halaman login")
chat — general conversation: a question, opinion, comment, or small talk that is NOT asking the bot to build/fix/change anything right now. This includes hypothetical or meta questions about what the bot would do or how it works (e.g. "kalau saya minta bikin aplikasi dari nol, apa yang bakal kamu lakukan", "gimana proses kamu kalau saya suruh bikin fitur baru") — these ask ABOUT a process, they are not themselves a request to start one, even though they mention building/fixing software.

A message describing a hypothetical task ("kalau saya minta X", "misalnya saya mau Y", "apa yang akan kamu lakukan jika...") without actually requesting it right now is "chat", not "task". If genuinely unsure, prefer "task".

Message: "${text}"`;
}

const KIND_LINE_RE = new RegExp(`^\\s*kind\\s*:\\s*(${MESSAGE_KINDS.join("|")})\\s*$`, "i");

// Line-by-line, forgiving on purpose — same rationale as the other
// classifiers in this directory: free-tier models don't always follow
// formatting instructions exactly, and a failed parse should degrade to
// "task" (treat as before) rather than block anything.
function parseMessageKindResponse(text: string): MessageKind {
  for (const line of text.split("\n")) {
    const match = line.match(KIND_LINE_RE);
    if (match) return match[1].toLowerCase() as MessageKind;
  }
  return "task";
}

export async function classifyMessageKind(
  text: string,
  provider: Provider,
  signal: AbortSignal
): Promise<MessageKind> {
  try {
    const response = await provider.chat([{ role: "user", content: buildMessageKindPrompt(text) }], [], signal);
    if (response.type !== "text") return "task";
    return parseMessageKindResponse(response.text);
  } catch {
    return "task";
  }
}
