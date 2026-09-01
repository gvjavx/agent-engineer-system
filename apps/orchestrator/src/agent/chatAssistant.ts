import type { ChatMessage, Provider } from "./types.js";
import { STYLE_RULES, currentDateLine } from "./dynamicReplies.js";
import { tryEvaluateArithmetic } from "./calc.js";
import { lookupCachedAnswer, type ChatKbOpts } from "./chatKb.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReplyResult {
  reply: string;
  newFact?: string;
  // Where the reply came from, none of which involved a model call except
  // "model": "arithmetic" = agent/calc.ts, "kb" = a stored answer to a
  // near-identical earlier question. The chat handler uses this to skip
  // re-recording a KB hit.
  source?: "model" | "arithmetic" | "kb";
}

export interface GenerateChatReplyOpts {
  // When set, a matching earlier answer for this sender is reused instead of
  // calling the model. kb carries the chat-KB test seams.
  fromNumber?: string;
  kb?: ChatKbOpts;
}

// Real multi-turn messages (system + history + the new user turn) rather
// than one flattened prompt string — both provider adapters already map
// this shape (gemini.ts pulls out the system message and converts user/
// assistant turns; openAiCompatible.ts passes them through 1:1), it's just
// never been exercised by this codebase's other one-shot callers, which all
// bake everything into a single user message.
// Only inject the "no internet / no live data" grounding when the message is
// actually about connectivity or current information. Kept always-on it bled
// into unrelated answers with flash-lite (real transcript: an internet
// disclaimer tacked onto "kapan hari kemerdekaan Indonesia").
const CONNECTIVITY_RE =
  /\b(internet|online|offline|web|browsing|browser|jaringan|koneksi|terhubung|nyambung|situs|website|google|real[\s-]?time|terkini|terbaru|berita|kabar terbaru|harga (sekarang|terkini|hari ini)|kurs|cuaca|skor|live)\b|akses.*(luar|data|internet)/i;

function buildSystemPrompt(message: string, facts: string[]): string {
  const factsBlock =
    facts.length > 0
      ? `Yang udah kamu tau soal user ini dari obrolan sebelumnya:\n${facts.map((f) => `- ${f}`).join("\n")}`
      : "Belum ada yang kamu tau soal user ini dari obrolan sebelumnya.";

  const connectivityBlock = CONNECTIVITY_RE.test(message)
    ? "\n\nYou have no internet access, no web search, and no live data in this chat. Say plainly you can't check or look things up — don't claim you're \"connected to the internet\" or can fetch the latest info. Answer only what you already know."
    : "";

  return `You are Mas ADE, a WhatsApp bot that helps people build or change software just by chatting in plain language. The user is just chatting/asking something — not instructing you to build or fix anything right now. ${STYLE_RULES} ${currentDateLine(message)}${connectivityBlock}

The message history below is context only, to understand what's already been discussed — answer ONLY the user's newest message. Do not restate, recap, quote, or re-answer anything from an earlier turn unless the new message explicitly asks you to — not even one sentence of it.

${factsBlock}

After your reply, add one final line with exactly this format:
FACT: <one short new fact worth remembering long-term about this user, in Indonesian>
Write it in second person ("kamu lagi ngerjain...", "kamu suka...") so it reads naturally if it ever gets quoted back to them in a later reply — not a third-person case note ("user sedang...", "user cenderung..."). Only record a concrete, durable fact about them that would still be true and useful weeks from now — an ongoing project, the stack/tools/language they work in, their role or domain, a firm preference or constraint they stated outright. Do NOT record: guesses about what they're thinking or feeling, their attitude toward you or how much they trust you ("kamu pengen mastiin aku bisa diandalkan", "kamu lagi nguji kemampuan aku"), or any commentary on how this conversation is going ("kamu nanya hitungan berkali-kali") — those aren't facts about them and read strangely quoted back later. Small talk, a one-off test question, or general trivia has nothing to record. Don't repeat anything already listed above. If there's nothing new worth remembering from this message, write exactly:
FACT: tidak ada`;
}

function buildChatMessages(message: string, history: ChatTurn[], facts: string[]): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(message, facts) },
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
  signal: AbortSignal,
  opts: GenerateChatReplyOpts = {}
): Promise<ChatReplyResult | undefined> {
  // Do the sums ourselves — a free-tier model gets multi-digit arithmetic
  // wrong and states it with invented precision. Nothing to remember from a
  // calculation, so no FACT extraction here.
  const arithmetic = tryEvaluateArithmetic(message);
  if (arithmetic) return { reply: arithmetic, source: "arithmetic" };

  // Already answered a near-identical question for this user? Reuse it, no
  // model call. No-ops unless the chat KB is on and has a close match.
  if (opts.fromNumber) {
    const cached = await lookupCachedAnswer({ fromNumber: opts.fromNumber, question: message }, opts.kb);
    if (cached) return { reply: cached, source: "kb" };
  }

  try {
    const response = await provider.chat(buildChatMessages(message, history, facts), [], signal);
    if (response.type !== "text") return undefined;
    const result = parseChatReply(response.text);
    return result.reply ? { ...result, source: "model" } : undefined;
  } catch {
    return undefined;
  }
}
