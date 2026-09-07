import { PROVIDER_REQUEST_TIMEOUT_MS } from "./types.js";

export interface HuggingfaceConfig {
  apiToken: string;
  editModel: string;
}

// Hugging Face Inference API, image-to-image. instruct-pix2pix takes the
// original image plus an instruction ("make it night") and edits in place.
// Returns raw image bytes on success; on a cold model it answers 503 with a
// JSON body, which we retry once.
export async function huggingfaceEditImage(
  hf: HuggingfaceConfig,
  prompt: string,
  imageBase64: string,
  signal: AbortSignal
): Promise<{ base64: string; mimeType: string }> {
  const url = `https://api-inference.huggingface.co/models/${hf.editModel}`;
  const body = JSON.stringify({
    inputs: imageBase64,
    parameters: { prompt, guidance_scale: 7.5 },
  });

  const call = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${hf.apiToken}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)]),
    });

  let res = await call();
  if (res.status === 503) {
    // Model was cold. HF says roughly how long the load takes; wait a bounded
    // slice of that, then try once more.
    const wait = await res
      .clone()
      .json()
      .then((b: { estimated_time?: number }) => Math.min((b.estimated_time ?? 20) * 1000, 45_000))
      .catch(() => 20_000);
    await new Promise((r) => setTimeout(r, wait));
    res = await call();
  }

  if (!res.ok) {
    throw new Error(`${hf.editModel}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    throw new Error(`${hf.editModel}: ${JSON.stringify(await res.json()).slice(0, 200)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${hf.editModel}: respons kosong`);
  return { base64: bytes.toString("base64"), mimeType: contentType || "image/png" };
}
