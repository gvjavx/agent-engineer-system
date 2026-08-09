import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolSchema } from "./types.js";

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "bash",
    description:
      "Run a shell command in the project's working directory (git, npm/pnpm/yarn, test runners, build tools, grep, find, gh CLI, etc.). Returns stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's contents, with line numbers, so you can reference exact lines when editing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file or overwrite it entirely with new content. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
        content: { type: "string", description: "The full new content of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact, unique substring within an existing file. Fails if old_string is not found or appears more than once — include enough surrounding context to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
        old_string: { type: "string", description: "Exact text to find (must be unique in the file)." },
        new_string: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
];

function resolveWithin(cwd: string, relPath: string): string {
  const resolved = path.resolve(cwd, relPath);
  const cwdWithSep = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
    throw new Error(`Path "${relPath}" resolves outside the project directory.`);
  }
  return resolved;
}

async function runBash(cwd: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" ? "bash.exe" : "/bin/bash" },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve(
          [
            `exit_code: ${exitCode}`,
            stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
            stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
          ].join("\n")
        );
      }
    );
  });
}

async function readFile(cwd: string, relPath: string): Promise<string> {
  const full = resolveWithin(cwd, relPath);
  const content = await fs.readFile(full, "utf-8");
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

async function writeFile(cwd: string, relPath: string, content: string): Promise<string> {
  const full = resolveWithin(cwd, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
  return `Wrote ${content.length} bytes to ${relPath}.`;
}

async function editFile(cwd: string, relPath: string, oldString: string, newString: string): Promise<string> {
  const full = resolveWithin(cwd, relPath);
  const content = await fs.readFile(full, "utf-8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_string not found in ${relPath}.`);
  }
  if (occurrences > 1) {
    throw new Error(`old_string appears ${occurrences} times in ${relPath}; it must be unique. Add more context.`);
  }
  await fs.writeFile(full, content.replace(oldString, newString), "utf-8");
  return `Edited ${relPath}.`;
}

export async function executeTool(name: string, input: Record<string, unknown>, cwd: string): Promise<string> {
  try {
    switch (name) {
      case "bash":
        return await runBash(cwd, String(input.command ?? ""));
      case "read_file":
        return await readFile(cwd, String(input.path ?? ""));
      case "write_file":
        return await writeFile(cwd, String(input.path ?? ""), String(input.content ?? ""));
      case "edit_file":
        return await editFile(cwd, String(input.path ?? ""), String(input.old_string ?? ""), String(input.new_string ?? ""));
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function briefToolDescription(name: string, input: Record<string, unknown>): string {
  if (name === "bash" && typeof input.command === "string") {
    const cmd = input.command;
    return `${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`;
  }
  if ((name === "write_file" || name === "edit_file") && typeof input.path === "string") {
    return `${name === "write_file" ? "Menulis" : "Mengedit"} ${input.path}`;
  }
  if (name === "read_file" && typeof input.path === "string") {
    return `Membaca ${input.path}`;
  }
  return `${name}`;
}

// Only a handful of milestone bash commands get pushed to WhatsApp as progress
// updates — everything else just goes to the audit log, to avoid spamming the user.
const MILESTONE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+commit\b/, label: "Commit dibuat" },
  { pattern: /\bgit\s+push\b/, label: "Push ke remote" },
  { pattern: /\bgh\s+pr\s+create\b/, label: "Pull request dibuat" },
  { pattern: /\bgh\s+pr\s+merge\b/, label: "Pull request di-merge" },
  { pattern: /\bgit\s+merge\b/, label: "Branch di-merge" },
  {
    pattern: /\b(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|run\s+lint)\b|\bpytest\b|\bgo\s+test\b/,
    label: "Menjalankan test/build",
  },
];

export function detectMilestone(name: string, input: Record<string, unknown>): string | undefined {
  if (name !== "bash" || typeof input.command !== "string") return undefined;
  for (const { pattern, label } of MILESTONE_PATTERNS) {
    if (pattern.test(input.command)) return label;
  }
  return undefined;
}
