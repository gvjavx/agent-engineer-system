import { config } from "../config.js";
import { buildGitSystemPrompt, buildLocalFolderSystemPrompt } from "./systemPrompt.js";
import { runAgentLoop } from "./loop.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAiCompatibleProvider } from "./providers/openAiCompatible.js";
import type { Provider } from "./types.js";

export type RunTaskParams = {
  taskId: string;
  cwd: string;
  projectAlias: string;
  instruction: string;
  abortController: AbortController;
  // Awaited at every call site — see loop.ts's RunAgentLoopParams.onProgress.
  onProgress: (text: string) => Promise<void>;
  // Provider name to try first (from "pakai model <nama>"). Falls back to the
  // rest of config.providerOrder if it fails — this only changes which
  // provider goes first, it never narrows the fallback chain.
  preferredProvider?: string;
  // Backs the send_document tool — see loop.ts for why this is a callback.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
  // Backs the WhatsApp confirmation gate for risky bash commands — see loop.ts.
  onDangerousBash?: (command: string, reason: string) => Promise<boolean>;
  // Extra system messages (currently the RAG code-context block) — passed
  // straight through to the agent loop. See agent/rag.
  extraSystemNotes?: string[];
} & (
  | { kind: "git"; defaultBranch: string; workBranch: string; autoMerge: "direct" | "pr" }
  | { kind: "local"; folderPath: string }
);

export interface RunTaskResult {
  ok: boolean;
  summary: string;
  // Mirrors RunAgentLoopResult.cancelled (loop.ts) — passed through as-is
  // since runTask just returns runAgentLoop's result directly. See
  // router/handler.ts's executeTask for how this drives work-branch cleanup.
  cancelled?: boolean;
}

// "<provider>" or "<provider>/<model>" — the /model suffix overrides the
// provider's env-configured default model. Used by "pakai model" (and the
// resulting preferredProvider / department_models values) so a department
// can pin a specific model, not just a provider.
export function splitProviderSpec(spec: string): { name: string; model?: string } {
  const slashIndex = spec.indexOf("/");
  if (slashIndex === -1) return { name: spec };
  return { name: spec.slice(0, slashIndex), model: spec.slice(slashIndex + 1) };
}

// The model a bare (no /model suffix) provider spec actually resolves to —
// used by "daftar model" to mark exactly one entry per provider as "(default)"
// instead of every fallback-model entry that happens to share the name.
export function primaryModelForProvider(name: string): string | undefined {
  if (name === "gemini") return config.gemini?.model;
  return config.openAiCompatibleProviders[name]?.model;
}

// One provider instance per API key configured for this name — lets someone
// register several keys for the same provider (e.g. 5 Gemini keys) so the
// loop rotates to the next key on a rate-limit/quota error instead of
// falling straight through to a different provider. Each key also expands
// across that provider's *_FALLBACK_MODELS (GEMINI_FALLBACK_MODELS,
// OPENROUTER_FALLBACK_MODELS, QWEN_FALLBACK_MODELS, ...): each model has its
// own separate free-tier quota bucket, so switching model on the SAME key
// clears a quota error faster than waiting on a retry or burning through
// other keys that'll hit the identical per-model limit. Only applies when
// nothing explicitly pinned a model (modelOverride) — "pakai model .../<model>"
// is a deliberate choice and shouldn't get silently overridden by a fallback.
function buildProvidersByName(name: string, modelOverride: string | undefined): Provider[] {
  if (name === "gemini" && config.gemini) {
    const models = modelOverride ? [modelOverride] : [config.gemini.model, ...config.gemini.fallbackModels];
    return config.gemini.apiKeys.flatMap((apiKey) => models.map((model) => new GeminiProvider({ apiKey, model })));
  }
  const openAiCompatible = config.openAiCompatibleProviders[name];
  if (openAiCompatible) {
    const models = modelOverride ? [modelOverride] : [openAiCompatible.model, ...openAiCompatible.fallbackModels];
    return openAiCompatible.apiKeys.flatMap((apiKey) =>
      models.map((model) => new OpenAiCompatibleProvider({ name, baseURL: openAiCompatible.baseUrl, apiKey, model }))
    );
  }
  return [];
}

// preferredProviderSpec (a "<provider>" or "<provider>/<model>" string) moves
// every entry belonging to that provider name to the front, as a group — so
// when a provider has several API keys, all of them get exhausted before
// falling through to a different provider, instead of just one key jumping
// the queue. Rebuilt with the override model if one was given; everyone else
// keeps their default model as the fallback. Exported (rather than folded
// into buildProviders) so this reordering logic is testable without touching
// the real env-backed config.
export function applyPreferredProvider(
  providers: Provider[],
  preferredProviderSpec: string | undefined,
  buildProvidersByNameFn: (name: string, modelOverride: string | undefined) => Provider[]
): Provider[] {
  if (!preferredProviderSpec) return providers;

  const { name, model } = splitProviderSpec(preferredProviderSpec);
  const preferred = model ? buildProvidersByNameFn(name, model) : providers.filter((p) => p.name === name);
  if (preferred.length === 0) return providers;

  return [...preferred, ...providers.filter((p) => p.name !== name)];
}

// Builds the fallback chain in config.providerOrder order, each provider
// expanded into one entry per configured API key (all sharing the same
// .name), each with its env-configured default model. "gemini" gets its own
// SDK-backed provider; every other name is generic OpenAI-compatible config
// (see config.ts) — so adding a new provider never touches this file. Also
// used by the "daftar model" WhatsApp command to check every configured
// provider/key's live status.
export function buildProviders(preferredProviderSpec?: string): Provider[] {
  const providers = config.providerOrder.flatMap((name) => buildProvidersByName(name, undefined));
  return applyPreferredProvider(providers, preferredProviderSpec, buildProvidersByName);
}

export async function runTask(params: RunTaskParams): Promise<RunTaskResult> {
  const {
    taskId,
    cwd,
    projectAlias,
    instruction,
    abortController,
    onProgress,
    preferredProvider,
    sendDocument,
    onDangerousBash,
    extraSystemNotes,
  } = params;

  const systemPrompt =
    params.kind === "git"
      ? buildGitSystemPrompt({
          projectAlias,
          defaultBranch: params.defaultBranch,
          workBranch: params.workBranch,
          autoMerge: params.autoMerge,
        })
      : buildLocalFolderSystemPrompt({ projectAlias, folderPath: params.folderPath });

  return runAgentLoop({
    providers: buildProviders(preferredProvider),
    systemPrompt,
    instruction,
    cwd,
    taskId,
    abortController,
    onProgress,
    sendDocument,
    onDangerousBash,
    extraSystemNotes,
  });
}
