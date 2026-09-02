import { runClassifier, type LocalClassifyOpts } from "./localClassifier.js";
import type { Provider } from "./types.js";

// Runs once before classifyDepartments on a fresh free-text task instruction
// (never on a checkpoint revision or a resumed clarify answer) — an
// instruction with zero concrete product information ("bikin website",
// "buatkan saya aplikasi") would otherwise turn straight into a 5-phase plan
// built on a pure guess, with the real requirement-gathering only happening
// after the user already confirmed that guess.
function buildClarityPrompt(instruction: string): string {
  return `The user sent this instruction to an autonomous coding agent that will actually build/change real software based on it, with no further back-and-forth until it's done. Decide if it has enough concrete information to start meaningful, correct work, or if it's so vague the agent would just be guessing at the product itself.

Only flag it as too vague when it has ZERO concrete indication of domain/purpose/target — e.g. "bikin website", "buatkan saya aplikasi", with nothing else at all. Do NOT flag anything that references something specific, even briefly: a feature name, a bug, an existing page/screen, a domain ("toko online", "portfolio", "blog resep masakan"), or anything else that gives the agent something concrete to build toward. Implementation-detail gaps (exact colors, exact copy, exact layout) are never a reason to ask — the agent decides those itself. When genuinely unsure, don't ask — proceed.

If it needs clarification, reply with exactly this format, nothing else:
CLARIFY: <one short, casual Indonesian question asking what kind of thing this is and its main purpose — nothing more>

Otherwise reply with exactly:
CLARIFY: tidak

Instruction: "${instruction}"`;
}

const CLARIFY_LINE_RE = /^\s*clarify\s*:\s*(.+)$/im;

// A present "CLARIFY:" line is a good read either way: "tidak" -> no question
// (value undefined), anything else -> that's the question. No line at all ->
// undefined, which lets runClassifier fall through to the vendor, and its
// fallback is also undefined (fail-open) — this must never block a real task
// over a classifier hiccup, same property commandIntent.ts's "task" fallback
// protects.
function parseClarityLine(text: string): { value: string | undefined } | undefined {
  const match = text.match(CLARIFY_LINE_RE);
  if (!match) return undefined;
  const value = match[1].trim();
  return { value: value.toLowerCase() === "tidak" ? undefined : value };
}

export async function checkNeedsClarification(
  instruction: string,
  provider: Provider,
  signal: AbortSignal,
  opts?: LocalClassifyOpts
): Promise<string | undefined> {
  return runClassifier<string | undefined>({
    prompt: buildClarityPrompt(instruction),
    provider,
    signal,
    parse: parseClarityLine,
    fallback: undefined,
    opts,
  });
}
