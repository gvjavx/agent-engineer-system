import { execFile } from "node:child_process";

// "deploy" — push the active project to Vercel via its CLI (npx). Token-gated:
// nothing happens without VERCEL_TOKEN in .env (same "built, needs config"
// stance as the Figma integration). Vercel's zero-config detection covers
// most framework repos; anything it can't build reports the CLI's own error.

const DEPLOY_TIMEOUT_MS = 8 * 60_000;

// First https URL in the output that looks like a deployment. Vercel prints
// the production URL on its own line; fall back to any https URL.
export function extractDeployUrl(output: string): string | undefined {
  return (
    output.match(/https:\/\/[^\s"'()]+\.vercel\.app[^\s"'()]*/i)?.[0] ??
    output.match(/https:\/\/[^\s"'()]+/i)?.[0]
  );
}

export async function deployToVercel(
  cwd: string,
  token: string,
  signal: AbortSignal
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--yes", "vercel@latest", "--prod", "--yes", "--token", token],
      { cwd, timeout: DEPLOY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        const url = extractDeployUrl(`${stdout}\n${stderr}`);
        if (url) return resolve({ ok: true, url });
        const msg = (stderr || (err && err.message) || "").trim().split("\n").slice(-3).join(" ");
        resolve({ ok: false, error: msg || "deploy jalan tapi URL-nya nggak kebaca dari output" });
      }
    );
  });
}
