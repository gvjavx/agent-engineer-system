import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { DepartmentKey } from "./agent/departments.js";

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

// Which provider each department uses before anyone ever types "pakai model
// <departemen>" — qwen/openrouter both default to qwen3-coder* models (see
// OPENAI_COMPATIBLE_DEFAULTS above), so "dev" gets an actually coding-tuned
// model out of the box instead of sharing Gemini with every chat reply.
// Overridable per department (or a whole new department key added) via
// DEPARTMENT_DEFAULT_PROVIDERS.
const DEPARTMENT_DEFAULT_PROVIDER_DEFAULTS: Partial<Record<DepartmentKey, string>> = {
  dev: "qwen",
  manajemen: "gemini",
};

function parseDepartmentDefaultProviders(raw: string): Partial<Record<DepartmentKey, string>> {
  const result: Partial<Record<DepartmentKey, string>> = {};
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const colonIndex = pair.indexOf(":");
    if (colonIndex === -1) continue;
    const dept = pair.slice(0, colonIndex).trim();
    const spec = pair.slice(colonIndex + 1).trim();
    if (dept && spec) result[dept as DepartmentKey] = spec;
  }
  return result;
}

// "<provider>" or "<provider>/<model>" -> just the provider name. Duplicated
// from runner.ts's splitProviderSpec (one line) rather than imported —
// runner.ts imports config.ts, so importing back would be circular.
function providerNameOf(spec: string): string {
  const slashIndex = spec.indexOf("/");
  return slashIndex === -1 ? spec : spec.slice(0, slashIndex);
}

// A default pointing at a provider nobody actually configured in
// AI_PROVIDER_ORDER would still silently no-op at execution time (see
// runner.ts's applyPreferredProvider), but it would keep showing up in
// "daftar model" and the task-plan preview as if it were really running —
// e.g. dev defaulting to "qwen" on a setup that only has Gemini keys filled
// in. Dropped here instead, so a department with no *usable* default just
// falls through to the flat provider order like it would with none set.
function keepOnlyConfiguredProviders(
  defaults: Partial<Record<DepartmentKey, string>>,
  configuredProviderNames: string[]
): Partial<Record<DepartmentKey, string>> {
  return Object.fromEntries(
    Object.entries(defaults).filter(([, spec]) => configuredProviderNames.includes(providerNameOf(spec)))
  ) as Partial<Record<DepartmentKey, string>>;
}

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

function envVarName(providerName: string, suffix: "API_KEY" | "BASE_URL" | "MODEL" | "FALLBACK_MODELS"): string {
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

  // Most task pipelines running at once across all projects (queue/taskQueue.ts).
  // Same-project tasks are already serial; this bounds the cross-project
  // parallelism so a burst doesn't run every free-tier provider dry at once.
  maxConcurrentTasks: Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS ?? 3)),

  // A second way in besides WhatsApp: the /cli/* routes let a local CLI
  // (apps/cli) drive the same agent. Gated by X-Internal-Secret + this flag;
  // off by default. Uses one stable conversation identity so `pakai <project>`
  // etc. persist. See src/cli/channel.ts.
  cli: {
    enabled: (process.env.CLI_ENABLED ?? "false").toLowerCase() === "true",
    senderId: process.env.CLI_SENDER_ID || "cli",
  },

  // Once-a-day unsolicited push to OWNER_WHATSAPP_NUMBER: last 24h of tasks
  // across all projects, today's schedules, provider usage. Off by default
  // (it's unsolicited). Hour is WIB, 0-23. See router/handler.ts's startDailyDigest.
  dailyDigest: {
    enabled: (process.env.DAILY_DIGEST_ENABLED ?? "false").toLowerCase() === "true",
    hour: Math.min(23, Math.max(0, Math.floor(Number(process.env.DAILY_DIGEST_HOUR ?? 7)))),
  },

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

  // This orchestrator's own source tree — where .env lives in local dev. Used
  // by agent/sandbox.ts to keep it out of a sandboxed bash command's view.
  repoRoot,

  // Hardening for the agent's `bash` tool (agent/sandbox.ts). "auto" (default):
  // scrub the child environment down to a safe allowlist always, and add
  // bubblewrap filesystem confinement when running on Linux with `bwrap`
  // installed. "bwrap": require bwrap (no fs confinement if it's missing, but
  // still scrub env). "none": env scrub only, never bwrap. "off": disable both
  // — the pre-hardening behavior.
  sandbox: {
    mode: (["auto", "bwrap", "none", "off"] as const).includes(
      (process.env.AGENT_SANDBOX ?? "auto").toLowerCase() as "auto" | "bwrap" | "none" | "off"
    )
      ? ((process.env.AGENT_SANDBOX ?? "auto").toLowerCase() as "auto" | "bwrap" | "none" | "off")
      : "auto",
    keepEnv: (process.env.AGENT_SANDBOX_KEEP_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Blocks the agent from committing anything that matches a high-confidence
  // leaked-credential shape, and warns once when a freshly registered repo
  // already contains one. On by default. See agent/secretScan.ts.
  secretScan: {
    enabled: (process.env.SECRET_SCAN_ENABLED ?? "true").toLowerCase() !== "false",
  },

  // Runs each project's configured test/lint command right before the agent
  // commits — a non-zero exit blocks the commit and the output goes back to
  // the model. On by default; only acts when a command is actually configured
  // or auto-detected from package.json. See agent/projectChecks.ts.
  commitChecks: {
    enabled: (process.env.COMMIT_CHECKS_ENABLED ?? "true").toLowerCase() !== "false",
  },

  // Off by default: one model pass over the staged diff before the agent's
  // first `git commit` in a task, surfacing only commit-blocking problems.
  // Costs one provider call per task when on. See agent/selfReview.ts.
  selfReview: {
    enabled: (process.env.SELF_REVIEW_ENABLED ?? "false").toLowerCase() === "true",
  },

  // Pause for a WhatsApp yes/no before a commit whose staged diff blows past
  // these bounds — catches runaway generation. On by default; asked at most
  // once per task. See agent/diffGuard.ts.
  diffGuard: {
    enabled: (process.env.DIFF_GUARD_ENABLED ?? "true").toLowerCase() !== "false",
    maxFiles: Math.max(1, Number(process.env.DIFF_GUARD_MAX_FILES ?? 60)),
    maxLines: Math.max(1, Number(process.env.DIFF_GUARD_MAX_LINES ?? 1500)),
  },

  // "deploy" command. Undefined (no VERCEL_TOKEN) => the command explains it
  // needs one and does nothing. See agent/deploy.ts.
  deploy: {
    vercelToken: process.env.VERCEL_TOKEN || undefined,
  },

  // Off by default: reply to a voice note with a voice note too. Costs one
  // Gemini TTS call per voiced reply — free-tier quota for the TTS models is
  // its own bucket and can be tight, hence opt-in. See agent/voiceReply.ts.
  voiceReply: {
    enabled: (process.env.VOICE_REPLY_ENABLED ?? "false").toLowerCase() === "true",
  },

  // "screenshot" command — brings up the project's dev server and captures it
  // with the bundled headless Chromium. On by default; a box without the
  // Chromium shared libs just fails the command gracefully. See agent/screenshot.ts.
  screenshot: {
    enabled: (process.env.SCREENSHOT_ENABLED ?? "true").toLowerCase() !== "false",
  },

  // After a git task pushes, poll the GitHub Actions runs for the pushed
  // commit; a failure is sent to WhatsApp with the log and an offer to fix
  // it. On by default; a repo with no Actions just stays quiet. See
  // agent/ciWatch.ts.
  ciWatch: {
    enabled: (process.env.CI_WATCH_ENABLED ?? "true").toLowerCase() !== "false",
    timeoutMinutes: Math.max(1, Number(process.env.CI_WATCH_TIMEOUT_MINUTES ?? 20)),
    // When on, a red CI run on a 'direct'-merge project is auto-reverted (the
    // task's own commits only), then the fix is offered on a clean branch.
    // Off by default. See router/handler.ts's watchCiAndReport.
    autoRevert: (process.env.CI_WATCH_AUTO_REVERT ?? "false").toLowerCase() === "true",
  },

  // Free AI providers, tried in this order with automatic fallback. Only
  // providers actually listed in AI_PROVIDER_ORDER get validated/built.
  providerOrder,

  // System-level default provider spec per department — see
  // DEPARTMENT_DEFAULT_PROVIDER_DEFAULTS above for why "dev" and "manajemen"
  // are set out of the box. Lowest-priority fallback: a user's own "pakai
  // model <departemen>"/"pakai model semua" always wins over this.
  departmentDefaultProviders: keepOnlyConfiguredProviders(
    process.env.DEPARTMENT_DEFAULT_PROVIDERS
      ? parseDepartmentDefaultProviders(process.env.DEPARTMENT_DEFAULT_PROVIDERS)
      : DEPARTMENT_DEFAULT_PROVIDER_DEFAULTS,
    providerOrder
  ),

  gemini: providerOrder.includes("gemini")
    ? {
        apiKeys: parseApiKeys(requiredForProvider("gemini", "GEMINI_API_KEY")),
        model: process.env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL,
        fallbackModels: parseApiKeys(process.env.GEMINI_FALLBACK_MODELS ?? GEMINI_DEFAULT_FALLBACK_MODELS),
        // Only used by the opt-in voice-note reply (config.voiceReply). The
        // chat model can't emit AUDIO, so TTS needs its own model name.
        ttsModel: process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts",
        // Image generation ("buatkan gambar ..."). Separate model, same reason
        // as TTS. Free-tier availability here is unstable and Google keeps
        // renaming these — so it's a comma-separated candidate list tried in
        // order, and GEMINI_IMAGE_MODEL overrides the whole list.
        imageModels: parseApiKeys(
          process.env.GEMINI_IMAGE_MODEL ??
            "gemini-2.5-flash-image,gemini-2.5-flash-image-preview,gemini-2.0-flash-preview-image-generation"
        ),
      }
    : undefined,

  // Cloudflare Workers AI — the actually-free image generator for "buatkan
  // gambar ..." (Gemini's image models need billing). Needs a free Cloudflare
  // account: account id + an API token scoped to Workers AI. Tried before
  // Gemini when set; absent, image requests fall back to Gemini (which will
  // usually 429 on a free key).
  cloudflareImage:
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
      ? {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          model: process.env.CLOUDFLARE_IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell",
        }
      : undefined,

  // Code retrieval for the agent loop (agent/rag/*). Off by default. Embeds
  // with the local model (agent/localEmbedder.ts) — no key, no rate limit;
  // needs @huggingface/transformers installed, absent it just no-ops.
  // Retrieval is additive and never blocks a task. Every numeric knob is
  // clamped so a bad .env value can't produce a zero-size window or an
  // unbounded context block.
  rag: {
    enabled: (process.env.RAG_ENABLED ?? "false").toLowerCase() === "true",
    topK: Math.max(1, Number(process.env.RAG_TOP_K ?? 8)),
    // Drop hits below this cosine score. The local model still scores
    // unrelated code well above 0, so 0 keeps everything and relies on topK;
    // raise it once you've seen how a real repo scores.
    minScore: Math.max(0, Number(process.env.RAG_MIN_SCORE ?? 0)),
    maxContextChars: Math.max(500, Number(process.env.RAG_MAX_CONTEXT_CHARS ?? 8000)),
    chunkLines: Math.max(10, Number(process.env.RAG_CHUNK_LINES ?? 60)),
    chunkOverlap: Math.max(0, Number(process.env.RAG_CHUNK_OVERLAP ?? 10)),
    maxFilesPerIndex: Math.max(1, Number(process.env.RAG_MAX_FILES_PER_INDEX ?? 600)),
    // When on, retrieval also pulls a few of the best-matching chunks from
    // OTHER registered projects (labelled as such), for cross-repo patterns.
    // Capped well below topK so the active project stays dominant; only
    // projects indexed with the current embed model are eligible.
    crossRepo: (process.env.RAG_CROSS_REPO ?? "false").toLowerCase() === "true",
  },

  // Stage 0 of the chat knowledge base: record every free-form chat Q&A into
  // interaction_kb, embedded when a Gemini key is present. Off by default —
  // it makes one embedding call per chat message and persists conversation
  // content. Nothing reads the store yet; this only starts the accumulation.
  chatKb: {
    enabled: (process.env.CHAT_KB_ENABLED ?? "false").toLowerCase() === "true",
    // The repeat match is local by default (no embedding call): exact after
    // normalization, or token-set overlap at/above this Jaccard score. 0.85
    // catches a dropped/added filler word; 1.0 means exact-tokens only.
    localMatchThreshold: Math.min(1, Math.max(0, Number(process.env.CHAT_KB_LOCAL_THRESHOLD ?? 0.85))),
    // Opt-in: when the text match misses, compare meaning with a small local
    // sentence-embedding model (agent/localEmbedder.ts) — no API, CPU-only.
    // Off unless CHAT_KB_SEMANTIC=true and @huggingface/transformers is installed.
    semanticFallback: (process.env.CHAT_KB_SEMANTIC ?? "false").toLowerCase() === "true",
    // Cosine (MiniLM q8) to treat two questions as the same. Measured: true
    // rewordings land ~0.77-0.90, a merely-related different question ~0.66,
    // unrelated ~0.13. 0.75 clears the rewordings and rejects the near-miss;
    // a wrong reuse is worse than a miss, so bias high.
    matchThreshold: Math.min(1, Math.max(0, Number(process.env.CHAT_KB_MATCH_THRESHOLD ?? 0.75))),
    // A cached answer older than this is ignored — the question goes back to
    // the model and the stored answer is replaced. Backstop for facts that
    // drift but don't trip the "volatile question" heuristic. 0 = never expire.
    maxAgeDays: Math.max(0, Math.floor(Number(process.env.CHAT_KB_MAX_AGE_DAYS ?? 90))),
    // With more than one number in ALLOWED_SENDERS: when on, a question one
    // sender already asked is answered from the store for any sender, not
    // just the one who first asked it — higher hit rate, fewer vendor calls.
    // Only non-volatile factual Q&A is ever stored, so there's nothing
    // sender-specific to leak. "lupain semua" still only clears the caller's
    // own contributions. Off by default; a single-sender setup sees no
    // difference either way.
    shared: (process.env.CHAT_KB_SHARED ?? "false").toLowerCase() === "true",
  },

  // A small local instruct model (agent/localLlm.ts) that answers non-coding
  // chat before Gemini is tried, so a genuinely new question doesn't
  // necessarily go to a vendor. CPU-only; a failure/timeout falls back to the
  // configured provider. Off unless CHAT_LOCAL_LLM=true and
  // @huggingface/transformers is installed. Coding tasks are unaffected.
  localLlm: {
    enabled: (process.env.CHAT_LOCAL_LLM ?? "false").toLowerCase() === "true",
  },

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
        // Same idea as GEMINI_FALLBACK_MODELS: no built-in default here since,
        // unlike Gemini, there's no key on hand to verify a candidate list
        // actually has working free-tier quota against — empty means no
        // behavior change until someone fills it in for their own key.
        const fallbackModels = parseApiKeys(process.env[envVarName(name, "FALLBACK_MODELS")] ?? "");
        return [name, { apiKeys, baseUrl, model, fallbackModels }];
      })
  ) as Record<string, { apiKeys: string[]; baseUrl: string; model: string; fallbackModels: string[] }>,
};
