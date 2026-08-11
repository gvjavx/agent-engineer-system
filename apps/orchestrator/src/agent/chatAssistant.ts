import type { ChatMessage, Provider } from "./types.js";
import { STYLE_RULES } from "./dynamicReplies.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReplyResult {
  reply: string;
  newFact?: string;
}

// Real multi-turn messages (system + history + the new user turn) rather
// than one flattened prompt string — both provider adapters already map
// this shape (gemini.ts pulls out the system message and converts user/
// assistant turns; openAiCompatible.ts passes them through 1:1), it's just
// never been exercised by this codebase's other one-shot callers, which all
// bake everything into a single user message.
function buildSystemPrompt(facts: string[]): string {
  const factsBlock =
    facts.length > 0
      ? `Yang udah kamu tau soal user ini dari obrolan sebelumnya:\n${facts.map((f) => `- ${f}`).join("\n")}`
      : "Belum ada yang kamu tau soal user ini dari obrolan sebelumnya.";

  return `You are Mas ADE, a WhatsApp bot that helps people build or change software just by chatting in plain language. The user is just chatting/asking something — not instructing you to build or fix anything right now. ${STYLE_RULES}

${factsBlock}

After your reply, add one final line with exactly this format:
FACT: <one short new fact worth remembering long-term about this user, in Indonesian>
Only include something genuinely new and worth remembering (preferences, ongoing projects, context about them) — don't repeat anything already listed above. If there's nothing new worth remembering from this message, write exactly:
FACT: tidak ada`;
}

function buildChatMessages(message: string, history: ChatTurn[], facts: string[]): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(facts) },
    ...history.map((turn) => ({ role: turn.role, content: turn.content }) satisfies ChatMessage),
    { role: "user", content: message },
  ];
}

const NO_FACT_VALUES = new Set(["", "tidak ada", "none", "nggak ada", "gak ada", "ga ada"]);
const FACT_LINE_RE = /^FACT:\s*(.*)$/im;

// Lenient on purpose, same reasoning as every other classifier in this
// directory: a free-tier model won't always follow the FACT: convention
// exactly, and a formatting miss should just mean "nothing learned this
// turn," never break the reply itself.
export function parseChatReply(raw: string): ChatReplyResult {
  const match = raw.match(FACT_LINE_RE);
  if (!match || typeof match.index !== "number") {
    return { reply: raw.trim() };
  }
  const reply = raw.slice(0, match.index).trim();
  const fact = match[1].trim();
  if (NO_FACT_VALUES.has(fact.toLowerCase())) {
    return { reply };
  }
  return { reply, newFact: fact };
}

export async function generateChatReply(
  message: string,
  history: ChatTurn[],
  facts: string[],
  provider: Provider,
  signal: AbortSignal
): Promise<ChatReplyResult | undefined> {
  try {
    const response = await provider.chat(buildChatMessages(message, history, facts), [], signal);
    if (response.type !== "text") return undefined;
    const result = parseChatReply(response.text);
    return result.reply ? result : undefined;
  } catch {
    return undefined;
  }
}
