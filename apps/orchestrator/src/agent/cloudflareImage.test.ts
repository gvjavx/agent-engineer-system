import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCloudflareImageProvider, cloudflareEditImage } from "./cloudflareImage.js";

const cfg = {
  accountId: "acct",
  apiToken: "tok",
  model: "@cf/black-forest-labs/flux-1-schnell",
  editModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
};
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

test("cloudflareEditImage hits the edit model with the image and returns the redrawn bytes", async () => {
  await withFetch(
    async (url, init) => {
      assert.match(String(url), /ai\/run\/@cf\/stabilityai\/stable-diffusion-xl-base-1\.0$/);
      const body = JSON.parse(String((init as RequestInit).body));
      assert.equal(body.prompt, "a red car at night");
      assert.equal(body.image_b64, "SU1H");
      assert.equal(typeof body.strength, "number");
      return new Response(Buffer.from("EDITEDPNG"), { status: 200, headers: { "content-type": "image/png" } });
    },
    async () => {
      const r = await cloudflareEditImage(cfg, "a red car at night", "SU1H", sig());
      assert.equal(Buffer.from(r.base64, "base64").toString(), "EDITEDPNG");
      assert.equal(r.mimeType, "image/png");
    }
  );
});

test("cloudflareEditImage surfaces the CF status and body on failure", async () => {
  await withFetch(
    async () => new Response("bad request", { status: 400 }),
    async () => {
      await assert.rejects(cloudflareEditImage(cfg, "x", "SU1H", sig()), /400 bad request/);
    }
  );
});
