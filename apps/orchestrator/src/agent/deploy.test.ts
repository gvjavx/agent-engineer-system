import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDeployUrl } from "./deploy.js";

test("extractDeployUrl prefers a *.vercel.app URL", () => {
  const out = [
    "Vercel CLI 39.0.0",
    "Inspect: https://vercel.com/acme/toko/abc123",
    "Production: https://toko-abc123-acme.vercel.app [2s]",
  ].join("\n");
  assert.equal(extractDeployUrl(out), "https://toko-abc123-acme.vercel.app");
});

test("extractDeployUrl falls back to any https URL, or undefined", () => {
  assert.equal(extractDeployUrl("deployed to https://example.com/x"), "https://example.com/x");
  assert.equal(extractDeployUrl("error: no build output"), undefined);
});
