import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { config } from "../config.js";
import type { Project } from "../db/index.js";

export function workspacePath(alias: string): string {
  return path.join(config.workspacesDir, alias);
}

// Injects the GitHub token into an https remote URL so clone/push/pull work headlessly.
function authenticatedUrl(repoUrl: string): string {
  if (!repoUrl.startsWith("https://")) return repoUrl;
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = config.githubToken;
  return url.toString();
}

export async function ensureWorkspace(project: Project): Promise<string> {
  const dir = workspacePath(project.alias);
  const remote = authenticatedUrl(project.repo_url);

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await simpleGit().clone(remote, dir);
  }

  const git = simpleGit(dir);
  await git.fetch("origin");
  await git.checkout(project.default_branch);
  await git.pull("origin", project.default_branch, { "--ff-only": null });
  return dir;
}

export async function createWorkBranch(dir: string, taskId: string): Promise<string> {
  const branch = `agent/${taskId.slice(0, 8)}`;
  await simpleGit(dir).checkoutLocalBranch(branch);
  return branch;
}
