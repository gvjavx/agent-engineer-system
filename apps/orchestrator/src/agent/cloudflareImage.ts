import type { Provider } from "./types.js";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "./types.js";
import { config } from "../config.js";

export interface CloudflareImageConfig {
  accountId: string;
  apiToken: string;
  model: string;
}

// Cloudflare Workers AI image generation — the free-tier path for "buatkan
// gambar ..." now that Gemini's image models are billing-only. flux-1-schnell
// answers with JSON { result: { image: "<base64 jpeg>" } }; the SD-family
// models answer with raw PNG bytes, so handle both.
export function makeCloudflareImageProvider(cf: CloudflareImageConfig): Provider {
  return {
    name: "cloudflare",
    chat: async () => {
      throw new Error("cloudflare image provider tidak bisa chat");
    },
    generateImage: async (prompt: string, signal: AbortSignal) => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/run/${cf.model}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cf.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)]),
      });

      if (!res.ok) {
        throw new Error(`${cf.model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }

      if ((res.headers.get("content-type") ?? "").includes("application/json")) {
        const body = (await res.json()) as { result?: { image?: string }; errors?: unknown };
        const b64 = body.result?.image;
        if (!b64) throw new Error(`${cf.model}: respons tanpa image (${JSON.stringify(body.errors ?? body).slice(0, 150)})`);
        return { base64: b64, mimeType: "image/jpeg" };
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) throw new Error(`${cf.model}: respons kosong`);
      return { base64: bytes.toString("base64"), mimeType: res.headers.get("content-type") || "image/png" };
    },
  };
}

// The configured provider as a one-element array (empty when unset), so
// callers can just spread it into their provider list.
export function cloudflareImageProviders(): Provider[] {
  return config.cloudflareImage ? [makeCloudflareImageProvider(config.cloudflareImage)] : [];
}
