import assert from "node:assert/strict";
import { test } from "node:test";
import { getValidAccessToken, type FigmaTokenResponse } from "./figmaAuth.js";
import { figmaOAuthRepo } from "../../db/index.js";

test.afterEach(() => {
  figmaOAuthRepo.clear();
});

test("getValidAccessToken returns undefined when Figma was never linked", async () => {
  figmaOAuthRepo.clear();
  const token = await getValidAccessToken();
  assert.equal(token, undefined);
});

test("getValidAccessToken returns the stored token as-is when it's still fresh", async () => {
  const now = Date.now();
  figmaOAuthRepo.save({
    access_token: "fresh-token",
    refresh_token: "refresh-me",
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const token = await getValidAccessToken({ nowMs: now });
  assert.equal(token, "fresh-token");
});

test("getValidAccessToken refreshes when the token is near expiry", async () => {
  const now = Date.now();
  figmaOAuthRepo.save({
    access_token: "stale-token",
    refresh_token: "refresh-me",
    expires_at: new Date(now + 60 * 1000).toISOString(), // 1 min left, under the 5 min margin
  });

  let calledWith: string | undefined;
  const refreshTokensFn = async (refreshToken: string): Promise<FigmaTokenResponse> => {
    calledWith = refreshToken;
    return { access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 };
  };

  const token = await getValidAccessToken({ nowMs: now, refreshTokensFn });
  assert.equal(token, "new-token");
  assert.equal(calledWith, "refresh-me");

  const stored = figmaOAuthRepo.get();
  assert.equal(stored?.access_token, "new-token");
  assert.equal(stored?.refresh_token, "new-refresh");
});

test("getValidAccessToken returns undefined when refresh fails", async () => {
  const now = Date.now();
  figmaOAuthRepo.save({
    access_token: "stale-token",
    refresh_token: "refresh-me",
    expires_at: new Date(now - 1000).toISOString(), // already expired
  });

  const refreshTokensFn = async (): Promise<FigmaTokenResponse> => {
    throw new Error("refresh_token invalid or expired");
  };

  const token = await getValidAccessToken({ nowMs: now, refreshTokensFn });
  assert.equal(token, undefined);
});
