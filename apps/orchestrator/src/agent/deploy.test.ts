import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDeployUrl } from "./deploy.js";

test("extractDeployUrl picks the *.vercel.app URL, not the Inspect dashboard link", () => {
  const out = [
    "Vercel CLI 39.0.0",
    "Inspect: https://vercel.com/acme/toko/abc123",
    "Production: https://toko-abc123-acme.vercel.app [2s]",
  ].join("\n");
  assert.equal(extractDeployUrl(out), "https://toko-abc123-acme.vercel.app");
});

test("extractDeployUrl returns undefined when there's no deployment URL", () => {
  assert.equal(extractDeployUrl("Inspect: https://vercel.com/acme/toko/abc123\nError: build failed"), undefined);
  assert.equal(extractDeployUrl("error: no build output"), undefined);
});
