import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCodeChallenge } from "./figmaAuth.js";

// Known-answer test straight from the PKCE spec (RFC 7636 appendix B) — the
// one thing that must never silently drift, since a wrong challenge doesn't
// error locally at all, it just makes Figma reject the callback later with
// no useful signal about why.
test("deriveCodeChallenge matches the RFC 7636 appendix B test vector", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = deriveCodeChallenge(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("deriveCodeChallenge is deterministic and base64url (no padding, no +/)", () => {
  const a = deriveCodeChallenge("some-random-verifier-value-here");
  const b = deriveCodeChallenge("some-random-verifier-value-here");
  assert.equal(a, b);
  assert.doesNotMatch(a, /[+/=]/);
});
