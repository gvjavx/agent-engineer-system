import { embedLocal, LOCAL_EMBED_IDENTITY } from "../localEmbedder.js";

// Code retrieval embeds through the same local sentence model as the chat KB
// (agent/localEmbedder.ts) — CPU, no API, no rate limit. `identity` changes
// with the model, so switching from the old Gemini embeddings forces a full
// reindex (see indexProject).
export interface EmbeddingProvider {
  name: string;
  identity: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  name = "local";
  identity = LOCAL_EMBED_IDENTITY;
  embed(texts: string[]): Promise<Float32Array[]> {
    return embedLocal(texts);
  }
}
