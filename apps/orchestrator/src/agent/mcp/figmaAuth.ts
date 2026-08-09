// One-time OAuth link to Figma's MCP server + automatic token refresh after
// that. Figma's MCP endpoint only accepts this OAuth flow (not a personal
// access token), and there's no headless/server-to-server variant, so the
// user has to open the authorize link once via "hubungkan figma" — everything
// after that is unattended.
import { config } from "../../config.js";
import { figmaOAuthRepo } from "../../db/index.js";

const AUTHORIZE_URL = "https://www.figma.com/oauth/mcp";
const TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface FigmaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

function requireFigmaConfig(): NonNullable<typeof config.figma> {
  if (!config.figma) {
    throw new Error(
      "Figma OAuth belum dikonfigurasi — isi FIGMA_MCP_CLIENT_ID dan FIGMA_OAUTH_REDIRECT_URI di .env dulu."
    );
  }
  return config.figma;
}

export function buildAuthorizeUrl(state: string): string {
  const figma = requireFigmaConfig();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", figma.clientId);
  url.searchParams.set("redirect_uri", figma.redirectUri);
  url.searchParams.set("scope", "mcp:connect");
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
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

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const figma = requireFigmaConfig();
  const body = new URLSearchParams({
    client_id: figma.clientId,
    redirect_uri: figma.redirectUri,
    code,
    grant_type: "authorization_code",
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
