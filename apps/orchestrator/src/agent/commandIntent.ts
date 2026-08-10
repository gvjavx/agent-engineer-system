import type { Provider } from "./types.js";

// Fallback for when the exact-phrase matchers in router/parse.ts miss a
// paraphrase of one of these 7 zero-argument commands ("gimana caranya pake
// ini" instead of "bantuan"). Argument-taking commands (tambah project,
// pakai model, dst.) stay exact-syntax — extracting an alias/URL/model name
// from loose phrasing is a different, riskier problem than recognizing intent.
export const COMMAND_INTENTS = [
  "intro",
  "help",
  "list_projects",
  "list_models",
  "status",
  "stop",
  "connect_figma",
  "none",
] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];

function buildCommandIntentPrompt(text: string): string {
  return `The user sent this WhatsApp message to a coding assistant bot. Decide if it means one of these fixed commands, or if it's something else entirely (e.g. a coding/development task instruction, a question, small talk).

Commands:
intro — asking who/what the bot is, asking it to introduce itself
help — asking what the bot can do, how to use it, or for a list of commands
list_projects — asking to see the list of already-registered projects
list_models — asking to see which AI providers/models are currently configured and usable (NOT asking to search/browse a specific provider's full model catalog — that's a different, unsupported-here request)
status — asking what task is currently running
stop — asking to cancel/stop the currently running task
connect_figma — asking to connect/link a Figma account
none — anything else, including any coding/development task or instruction, however short, and anything not confidently one of the above

Reply with exactly one line, in exactly this format, nothing else:
INTENT: <key>

Use only these exact keys: ${COMMAND_INTENTS.join(", ")}.

Message: "${text}"`;
}

const INTENT_LINE_RE = new RegExp(`^\\s*intent\\s*:\\s*(${COMMAND_INTENTS.join("|")})\\s*$`, "i");

// Line-by-line, forgiving on purpose — same rationale as classifier.ts's
// parseClassifierResponse: free-tier models don't always follow formatting
// instructions exactly, and a failed parse should degrade to "none" (treat
// as before) rather than block anything.
function parseCommandIntentResponse(text: string): CommandIntent {
  for (const line of text.split("\n")) {
    const match = line.match(INTENT_LINE_RE);
    if (match) return match[1].toLowerCase() as CommandIntent;
  }
  return "none";
}

export async function classifyCommandIntent(
  text: string,
  provider: Provider,
  signal: AbortSignal
): Promise<CommandIntent> {
  try {
    const response = await provider.chat([{ role: "user", content: buildCommandIntentPrompt(text) }], [], signal);
    if (response.type !== "text") return "none";
    return parseCommandIntentResponse(response.text);
  } catch {
    return "none";
  }
}
