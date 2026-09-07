import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCloudflareImageProvider } from "./cloudflareImage.js";

const cfg = { accountId: "acct", apiToken: "tok", model: "@cf/black-forest-labs/flux-1-schnell" };
const sig = () => new AbortController().signal;

async function withFetch(stub: typeof fetch, run: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
}

test("makeCloudflareImageProvider returns base64 from a flux-schnell JSON response", async () => {
  await withFetch(
    async (url, init) => {
      assert.match(String(url), /accounts\/acct\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
      assert.equal(JSON.parse(String((init as RequestInit).body)).prompt, "pohon");
      return new Response(JSON.stringify({ result: { image: "aGVsbG8=" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const p = makeCloudflareImageProvider(cfg);
      assert.deepEqual(await p.generateImage!("pohon", sig()), { base64: "aGVsbG8=", mimeType: "image/jpeg" });
    }
  );
});

test("makeCloudflareImageProvider handles a raw-bytes response", async () => {
  await withFetch(
    async () => new Response(Buffer.from("PNGDATA"), { status: 200, headers: { "content-type": "image/png" } }),
    async () => {
      const r = await makeCloudflareImageProvider(cfg).generateImage!("x", sig());
      assert.equal(Buffer.from(r.base64, "base64").toString(), "PNGDATA");
      assert.equal(r.mimeType, "image/png");
    }
  );
});

test("makeCloudflareImageProvider throws with the status and body on a non-ok response", async () => {
  await withFetch(
    async () => new Response("nope", { status: 403 }),
    async () => {
      await assert.rejects(makeCloudflareImageProvider(cfg).generateImage!("x", sig()), /403 nope/);
    }
  );
});

test("makeCloudflareImageProvider throws when JSON has no image", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(makeCloudflareImageProvider(cfg).generateImage!("x", sig()), /tanpa image/);
    }
  );
});
