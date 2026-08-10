import type { Provider } from "./types.js";

// Fallback for interpreting a reply to a yes/no confirmation (approving a
// flagged-risky bash command, a local folder registration, or a pipeline
// plan) when it doesn't match the exact-phrase sets in router/parse.ts.
// Every failure mode below returns "unclear", never "yes" — that's what
// makes fail-closed a structural property of this function, not something
// each caller has to remember to enforce.
export const CONFIRMATION_INTENTS = ["yes", "no", "unclear"] as const;
export type ConfirmationIntent = (typeof CONFIRMATION_INTENTS)[number];

function buildConfirmationIntentPrompt(text: string): string {
  return `The user was asked a yes/no confirmation question in a WhatsApp chat. Decide what their reply means.

Reply with exactly one line, in exactly this format, nothing else:
ANSWER: <key>

Use only these exact keys:
yes — clearly agreeing/confirming/approving
no — clearly declining/rejecting/cancelling
unclear — anything else: a question, an unrelated statement, a request to change something, or genuine ambiguity — anything that is not confidently a yes or a no

Message: "${text}"`;
}

const ANSWER_LINE_RE = new RegExp(`^\\s*answer\\s*:\\s*(${CONFIRMATION_INTENTS.join("|")})\\s*$`, "i");

function parseConfirmationIntentResponse(text: string): ConfirmationIntent {
  for (const line of text.split("\n")) {
    const match = line.match(ANSWER_LINE_RE);
    if (match) return match[1].toLowerCase() as ConfirmationIntent;
  }
  return "unclear";
}

export async function classifyConfirmationIntent(
  text: string,
  provider: Provider,
  signal: AbortSignal
): Promise<ConfirmationIntent> {
  try {
    const response = await provider.chat([{ role: "user", content: buildConfirmationIntentPrompt(text) }], [], signal);
    if (response.type !== "text") return "unclear";
    return parseConfirmationIntentResponse(response.text);
  } catch {
    return "unclear";
  }
}
