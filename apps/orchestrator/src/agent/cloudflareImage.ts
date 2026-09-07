import type { Provider } from "./types.js";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "./types.js";
import { config } from "../config.js";

export interface CloudflareImageConfig {
  accountId: string;
  apiToken: string;
  model: string;
  editModel: string;
}

// Cloudflare Workers AI image generation — the free-tier path for "buatkan
// gambar ..." now that Gemini's image models are billing-only. flux-1-schnell
// answers with JSON { result: { image: "<base64 jpeg>" } }; the SD-family
// models answer with raw PNG bytes, so handle both.
async function runModel(
  cf: CloudflareImageConfig,
  model: string,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cf.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`);

  // flux-1-schnell answers { result: { image: "<base64>" } }; the SD family
  // answers with raw PNG bytes.
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await res.json()) as { result?: { image?: string }; errors?: unknown };
    const b64 = body.result?.image;
    if (!b64) throw new Error(`${model}: respons tanpa image (${JSON.stringify(body.errors ?? body).slice(0, 150)})`);
    return { base64: b64, mimeType: "image/jpeg" };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${model}: respons kosong`);
  return { base64: bytes.toString("base64"), mimeType: res.headers.get("content-type") || "image/png" };
}

export function makeCloudflareImageProvider(cf: CloudflareImageConfig): Provider {
  return {
    name: "cloudflare",
    chat: async () => {
      throw new Error("cloudflare image provider tidak bisa chat");
    },
    generateImage: (prompt, signal) => runModel(cf, cf.model, { prompt }, signal),
  };
}

// img2img: redraw an uploaded image toward the prompt. `strength` (0-1) is how
// far to move from the original — ~0.6 keeps the composition but honours the
// change. Returns raw PNG bytes.
export async function cloudflareEditImage(
  cf: CloudflareImageConfig,
  prompt: string,
  imageBase64: string,
  signal: AbortSignal
): Promise<{ base64: string; mimeType: string }> {
  return runModel(cf, cf.editModel, { prompt, image_b64: imageBase64, strength: 0.6, guidance: 7.5 }, signal);
}

// The configured provider as a one-element array (empty when unset), so
// callers can just spread it into their provider list.
export function cloudflareImageProviders(): Provider[] {
  return config.cloudflareImage ? [makeCloudflareImageProvider(config.cloudflareImage)] : [];
}
