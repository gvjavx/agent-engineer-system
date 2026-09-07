import assert from "node:assert/strict";
import { test } from "node:test";
import { huggingfaceEditImage } from "./huggingfaceImage.js";

const hf = { apiToken: "hf_tok", editModel: "timbrooks/instruct-pix2pix" };
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

test("huggingfaceEditImage posts the image + prompt and returns the edited bytes", async () => {
  await withFetch(
    async (url, init) => {
      assert.match(String(url), /api-inference\.huggingface\.co\/models\/timbrooks\/instruct-pix2pix$/);
      assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer hf_tok");
      const body = JSON.parse(String(init!.body));
      assert.equal(body.inputs, "SU1H");
      assert.equal(body.parameters.prompt, "make it night");
      return new Response(Buffer.from("EDITEDPNG"), { status: 200, headers: { "content-type": "image/png" } });
    },
    async () => {
      const r = await huggingfaceEditImage(hf, "make it night", "SU1H", sig());
      assert.equal(Buffer.from(r.base64, "base64").toString(), "EDITEDPNG");
      assert.equal(r.mimeType, "image/png");
    }
  );
});

test("huggingfaceEditImage retries once on a 503 cold start, then succeeds", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "loading", estimated_time: 0.001 }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from("WARM"), { status: 200, headers: { "content-type": "image/jpeg" } });
    },
    async () => {
      const r = await huggingfaceEditImage(hf, "x", "SU1H", sig());
      assert.equal(calls, 2);
      assert.equal(Buffer.from(r.base64, "base64").toString(), "WARM");
      assert.equal(r.mimeType, "image/jpeg");
    }
  );
});

test("huggingfaceEditImage throws with the status and body on a hard error", async () => {
  await withFetch(
    async () => new Response("nope", { status: 401 }),
    async () => {
      await assert.rejects(huggingfaceEditImage(hf, "x", "SU1H", sig()), /401 nope/);
    }
  );
});

test("huggingfaceEditImage throws when a 200 carries a JSON error instead of an image", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: "input too large" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(huggingfaceEditImage(hf, "x", "SU1H", sig()), /input too large/);
    }
  );
});
