import type { Provider } from "./types.js";
import { ProviderError } from "./types.js";

export type ProviderStatus =
  | { state: "ok" }
  | { state: "rate_limited"; message: string }
  | { state: "error"; message: string };

const RATE_LIMIT_PATTERNS = [/\b429\b/, /RESOURCE_EXHAUSTED/i, /rate.?limit/i, /\bquota\b/i];

function classifyErrorMessage(message: string): ProviderStatus {
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { state: "rate_limited", message };
  }
  return { state: "error", message };
}

// Fires a trivial prompt to see if the key actually works right now — env
// vars being set doesn't mean the key is valid or under quota.
//
// Promise.race with a real timer, not just an AbortSignal: the Gemini SDK
// bundles its own retry logic (p-retry) that doesn't always honor an
// aborted signal mid-retry on a 429, so relying on the signal alone can hang
// way past timeoutMs. chatStatus keeps its own .catch() so the abandoned
// call can't blow up later as an unhandled rejection.
export async function checkProviderStatus(provider: Provider, timeoutMs = 15000): Promise<ProviderStatus> {
  const controller = new AbortController();

  const chatStatus = provider
    .chat([{ role: "user", content: "ping" }], [], controller.signal)
    .then((): ProviderStatus => ({ state: "ok" }))
    .catch((err): ProviderStatus => {
      const message = err instanceof ProviderError || err instanceof Error ? err.message : String(err);
      return classifyErrorMessage(message);
    });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutStatus = new Promise<ProviderStatus>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ state: "error", message: "Timeout — provider tidak merespons dalam waktu wajar." });
    }, timeoutMs);
  });

  const result = await Promise.race([chatStatus, timeoutStatus]);
  clearTimeout(timer!);
  return result;
}
