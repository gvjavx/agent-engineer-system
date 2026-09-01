import { config } from "../config.js";
import { chatKbRepo } from "../db/chatKb.js";
import { buildEmbeddingProvider, type EmbeddingProvider } from "./rag/index.js";

export type InteractionKind = "chat_model" | "chat_arithmetic";

export interface RecordInteractionOpts {
  // Test seams. enabled overrides the config flag; embedder null = "no
  // embedder", undefined = build the real one.
  enabled?: boolean;
  embedder?: EmbeddingProvider | null;
}

// Stage 0: write a chat Q&A into the knowledge base, and best-effort backfill
// its question vector. Nothing reads this yet. Called fire-and-forget from the
// chat handler — a failure here must never touch the reply the user already
// got, so every step is guarded and the row is saved before the embedding is
// even attempted.
export async function recordInteraction(
  params: { fromNumber: string; kind: InteractionKind; question: string; answer: string },
  opts: RecordInteractionOpts = {}
): Promise<void> {
  if (!(opts.enabled ?? config.chatKb.enabled)) return;
  const { fromNumber, kind, question, answer } = params;
  if (!question.trim() || !answer.trim()) return;

  let id: number;
  try {
    id = chatKbRepo.insert(fromNumber, kind, question, answer);
  } catch {
    return;
  }

  // An arithmetic answer needs no vector — the calculator (agent/calc.ts)
  // already generalizes over every expression, so there's nothing to retrieve.
  if (kind === "chat_arithmetic") return;

  const embedder = opts.embedder === undefined ? buildEmbeddingProvider() : opts.embedder ?? undefined;
  if (!embedder) return;

  try {
    const [vec] = await embedder.embed([question], "document", new AbortController().signal);
    if (vec) chatKbRepo.setEmbedding(id, vec);
  } catch {
    // Row stays saved with a NULL embedding; a later backfill pass can pick it up.
  }
}
