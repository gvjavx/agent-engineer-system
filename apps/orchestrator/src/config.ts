import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/orchestrator/src (or dist, once built) -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Loads repo-root .env for local dev. In Docker, env vars come from the
// compose env_file instead and no .env exists in the image, so this is a
// harmless no-op there; either way it never overrides already-set vars.
dotenv.config({ path: path.join(repoRoot, ".env") });

// gemini gets its own SDK; anything else in AI_PROVIDER_ORDER is assumed
// OpenAI-compatible and resolved via <NAME>_API_KEY/_BASE_URL/_MODEL — so new
// providers (Groq, Mistral, ...) never need code changes, just env vars.
const OPENAI_COMPATIBLE_DEFAULTS: Record<string, { baseUrl?: string; model?: string }> = {
  qwen: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen3-coder-plus" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-coder:free" },
};

// gemini-2.5-flash and 2.0-flash both dropped to a 0-request free quota for
// new keys within a year of launch, and -latest currently points at a model
// with only 5rpm free — too tight for a multi-tool-call turn. flash-lite
// held up better in testing. Re-check ai.google.dev/gemini-api/docs/rate-limits
// if this starts erroring.
const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";

// Each Gemini model has its own separate free-tier quota bucket, so a 429 on
// the default model doesn't mean a 429 on these too — runner.ts tries them,
// same key, before rotating to the next key/provider. Verified live against
// a real key while wiring this up; gemini-2.5-flash and gemini-2.5-flash-lite
// both 404 as "no longer available to new users", which is exactly the kind
// of quota/availability drift the comment above already warns about.
const GEMINI_DEFAULT_FALLBACK_MODELS = "gemini-flash-lite-latest,gemini-3.5-flash-lite";

function requiredForProvider(providerName: string, envVar: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(
      `Provider "${providerName}" ada di AI_PROVIDER_ORDER tapi env var ${envVar} belum diisi di .env.`
    );
  }
  return value;
}

// Comma-separated so you can register several API keys for the same
// provider (e.g. 5 Gemini keys) — the agent rotates to the next one when the
// current key hits a rate limit/quota error, before falling back to a
// different provider entirely.
function parseApiKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envVarName(providerName: string, suffix: "API_KEY" | "BASE_URL" | "MODEL"): string {
  return `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
}

const providerOrder = (process.env.AI_PROVIDER_ORDER ?? "gemini,openrouter,qwen")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (providerOrder.length === 0) {
  throw new Error("AI_PROVIDER_ORDER tidak boleh kosong — isi minimal satu provider.");
}

export const config = {
  port: Number(process.env.ORCHESTRATOR_PORT ?? 4000),

  // How long a user can go without sending a message before their current
  // chat session is considered over — see session/idleNotifier.ts.
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),

  githubToken: required("GITHUB_TOKEN"),

  internalSharedSecret: required("INTERNAL_SHARED_SECRET"),
  gatewayUrl: process.env.GATEWAY_URL ?? "http://whatsapp-gateway:3000",

  // Re-checked here too, not just in whatsapp-gateway's own copy of this list —
  // /inbound only trusts X-Internal-Secret, so without this a leaked internal
  // secret (or a port-4000 misconfiguration) would let anyone impersonate the
  // owner and command the agent directly, bypassing the gateway's filter entirely.
  allowedSenders: (process.env.ALLOWED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Default WhatsApp number (E.164, no "+") to send unsolicited/global notices to.
  ownerNumber: required("OWNER_WHATSAPP_NUMBER"),

  workspacesDir: process.env.WORKSPACES_DIR ?? path.join(repoRoot, "workspaces"),
  dbPath: process.env.DB_PATH ?? path.join(repoRoot, "data", "orchestrator.sqlite"),

  // Free AI providers, tried in this order with automatic fallback. Only
  // providers actually listed in AI_PROVIDER_ORDER get validated/built.
  providerOrder,

  gemini: providerOrder.includes("gemini")
    ? {
        apiKeys: parseApiKeys(requiredForProvider("gemini", "GEMINI_API_KEY")),
        model: process.env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL,
        fallbackModels: parseApiKeys(process.env.GEMINI_FALLBACK_MODELS ?? GEMINI_DEFAULT_FALLBACK_MODELS),
      }
    : undefined,

  // Optional — only set once someone actually registers a Figma OAuth app
  // and runs "hubungkan figma". Left undefined otherwise so the rest of the
  // system works fine without it.
  figma:
    process.env.FIGMA_MCP_CLIENT_ID && process.env.FIGMA_OAUTH_REDIRECT_URI
      ? {
          clientId: process.env.FIGMA_MCP_CLIENT_ID,
          clientSecret: process.env.FIGMA_MCP_CLIENT_SECRET,
          redirectUri: process.env.FIGMA_OAUTH_REDIRECT_URI,
        }
      : undefined,

  // Keyed by provider name — one entry per non-"gemini" name in
  // AI_PROVIDER_ORDER, built purely from the <NAME>_API_KEY/BASE_URL/MODEL
  // convention (see comment above OPENAI_COMPATIBLE_DEFAULTS). API_KEY can be
  // a comma-separated list, same as GEMINI_API_KEY above.
  openAiCompatibleProviders: Object.fromEntries(
    providerOrder
      .filter((name) => name !== "gemini")
      .map((name) => {
        const defaults = OPENAI_COMPATIBLE_DEFAULTS[name];
        const apiKeys = parseApiKeys(requiredForProvider(name, envVarName(name, "API_KEY")));
        const baseUrl = process.env[envVarName(name, "BASE_URL")] ?? defaults?.baseUrl;
        if (!baseUrl) {
          throw new Error(
            `Provider "${name}" butuh env var ${envVarName(name, "BASE_URL")} (endpoint OpenAI-compatible-nya) di .env.`
          );
        }
        const model = process.env[envVarName(name, "MODEL")] ?? defaults?.model;
        if (!model) {
          throw new Error(`Provider "${name}" butuh env var ${envVarName(name, "MODEL")} di .env.`);
        }
        return [name, { apiKeys, baseUrl, model }];
      })
  ) as Record<string, { apiKeys: string[]; baseUrl: string; model: string }>,
};
