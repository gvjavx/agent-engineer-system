import { config } from "../config.js";
import { generateStructuredLocal } from "./localLlm.js";
import type { Provider } from "./types.js";

// Shared runner for the four small structured classifiers (classifier.ts,
// commandIntent.ts, confirmationIntent.ts, requestClarity.ts). Each of those
// used to be one network round-trip to a free-tier provider before the user
// got any reply at all. With CHAT_LOCAL_LLM on, the local model gets first
// crack; its output is kept only if `parse` accepts it, otherwise the
// configured provider answers exactly as before.
//
// `parse` returns `{ value }` on a good read (value itself may be undefined
// where that's a real result, e.g. "no clarification needed"), or `undefined`
// to mean "couldn't read this" — the only case that falls through to the
// vendor. Every caller's fallback is fail-safe in its own direction (task /
// unclear / semua / no-clarify), so a local miss never resolves to a wrong
// class, it just costs the vendor call it would have cost anyway.

const LOCAL_CLASSIFIER_SYSTEM =
  "You are a precise text classifier. Follow the instructions exactly and reply only in the requested one-line format — no explanation, no preamble, no extra text.";

export interface LocalClassifyOpts {
  // Defaults to config.localLlm.enabled. Tests pass this explicitly.
  localEnabled?: boolean;
  // Defaults to the real local model. Tests pass a stub.
  localGen?: (system: string, user: string) => Promise<string | undefined>;
}

export async function runClassifier<T>(args: {
  prompt: string;
  provider: Provider;
  signal: AbortSignal;
  parse: (text: string) => { value: T } | undefined;
  fallback: T;
  opts?: LocalClassifyOpts;
}): Promise<T> {
  const { prompt, provider, signal, parse, fallback, opts } = args;
  const localEnabled = opts?.localEnabled ?? config.localLlm.enabled;
  const localGen = opts?.localGen ?? generateStructuredLocal;

  if (localEnabled) {
    try {
      const out = await localGen(LOCAL_CLASSIFIER_SYSTEM, prompt);
      const parsed = out ? parse(out) : undefined;
      if (parsed) return parsed.value;
    } catch {
      // fall through to the vendor
    }
  }

  try {
    const response = await provider.chat([{ role: "user", content: prompt }], [], signal);
    if (response.type !== "text") return fallback;
    const parsed = parse(response.text);
    return parsed ? parsed.value : fallback;
  } catch {
    return fallback;
  }
}
