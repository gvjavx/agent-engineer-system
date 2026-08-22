// One-time OAuth link to Figma's MCP server + automatic token refresh after
// that. Figma's MCP endpoint only accepts this OAuth flow (not a personal
// access token), and there's no headless/server-to-server variant, so the
// user has to open the authorize link once via "hubungkan figma" — everything
// after that is unattended.
import crypto from "node:crypto";
import { config } from "../../config.js";
import { figmaOAuthRepo, figmaAppConfigRepo } from "../../db/index.js";

const AUTHORIZE_URL = "https://www.figma.com/oauth/mcp";
const TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// RFC 8707 resource indicator — Figma's MCP server (unlike its older
// per-file REST API OAuth) is reported to require this on both the
// authorize and token requests, identifying which protected resource
// (the MCP server itself) the requested token is for. Not confirmed
// against official Figma documentation (they don't publish the raw MCP
// OAuth parameter spec) — this is the next candidate after PKCE for the
// "Invalid scope: mcp:connect" error, based on third-party reports.
const MCP_RESOURCE = "https://mcp.figma.com/mcp";

export interface FigmaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

// Chat-configured (via "hubungkan figma") takes priority over the env-based
// config.figma — same "explicit choice wins" precedence used elsewhere in
// this codebase — so nobody who already set FIGMA_MCP_CLIENT_ID in .env
// loses anything, but the chat wizard is the primary path now.
function requireFigmaConfig(): { clientId: string; clientSecret?: string; redirectUri: string } {
  const stored = figmaAppConfigRepo.get();
  if (stored) {
    return { clientId: stored.client_id, clientSecret: stored.client_secret ?? undefined, redirectUri: stored.redirect_uri };
  }
  if (config.figma) return config.figma;
  throw new Error('Figma OAuth belum disetel. Ketik "hubungkan figma" buat mulai nyetelnya.');
}

// PKCE (RFC 7636) — Figma's authorize endpoint rejects the request outright
// without a code_challenge ("Parameter code_challenge is required"), even
// though this app also has a client_secret. codeVerifier is the raw secret
// generated alongside state in figmaOAuthState.ts; this derives the
// challenge sent here, and the same verifier gets sent (unhashed) at the
// token-exchange step in exchangeCodeForTokens for Figma to check it matches.
export function deriveCodeChallenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

export function buildAuthorizeUrl(state: string, codeVerifier: string): string {
  const figma = requireFigmaConfig();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", figma.clientId);
  url.searchParams.set("redirect_uri", figma.redirectUri);
  url.searchParams.set("scope", "mcp:connect");
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", deriveCodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", MCP_RESOURCE);
  return url.toString();
}

async function requestTokens(body: URLSearchParams): Promise<FigmaTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Figma token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as FigmaTokenResponse;
}

function saveTokens(tokens: FigmaTokenResponse, nowMs: number): void {
  figmaOAuthRepo.save({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(nowMs + tokens.expires_in * 1000).toISOString(),
  });
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
  const figma = requireFigmaConfig();
  const body = new URLSearchParams({
    client_id: figma.clientId,
    redirect_uri: figma.redirectUri,
    code,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
    resource: MCP_RESOURCE,
  });
  if (figma.clientSecret) body.set("client_secret", figma.clientSecret);
  saveTokens(await requestTokens(body), Date.now());
}

async function refreshTokensViaFigma(refreshToken: string): Promise<FigmaTokenResponse> {
  const figma = requireFigmaConfig();
  const body = new URLSearchParams({
    client_id: figma.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    resource: MCP_RESOURCE,
  });
  if (figma.clientSecret) body.set("client_secret", figma.clientSecret);
  return requestTokens(body);
}

// nowMs/refreshTokensFn are DI seams for tests — real callers never pass them.
export async function getValidAccessToken(params?: {
  nowMs?: number;
  refreshTokensFn?: (refreshToken: string) => Promise<FigmaTokenResponse>;
}): Promise<string | undefined> {
  const stored = figmaOAuthRepo.get();
  if (!stored) return undefined;

  const now = params?.nowMs ?? Date.now();
  const expiresAt = new Date(stored.expires_at).getTime();
  if (expiresAt - now > REFRESH_MARGIN_MS) {
    return stored.access_token;
  }

  try {
    const refreshFn = params?.refreshTokensFn ?? refreshTokensViaFigma;
    const refreshed = await refreshFn(stored.refresh_token);
    saveTokens(refreshed, now);
    return refreshed.access_token;
  } catch {
    return undefined;
  }
}
