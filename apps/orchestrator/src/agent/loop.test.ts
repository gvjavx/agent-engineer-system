import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "./loop.js";
import type { FigmaToolsResult } from "./mcp/figmaTools.js";
import { ProviderError } from "./types.js";
import type { Provider, ToolSchema, ChatMessage, ProviderResponse } from "./types.js";

function baseParams(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return {
    providers: [] as Provider[],
    systemPrompt: "system",
    instruction: "do something",
    cwd: "/does/not/matter",
    taskId: "test-task",
    abortController: new AbortController(),
    onProgress: async () => {},
    rateLimitRetryDelayMs: 0,
    ...overrides,
  };
}

test("runAgentLoop never calls any provider when Figma isn't linked yet", async () => {
  let providerCalled = false;
  const provider: Provider = {
    name: "fake",
    async chat(): Promise<ProviderResponse> {
      providerCalled = true;
      return { type: "text", text: "should not get here" };
    },
  };

  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "not_linked" });

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.equal(providerCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.recoverable, undefined);
  assert.match(result.summary, /Figma/);
});

test("runAgentLoop surfaces a connection error without running the loop", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "error", message: "boom" });
  const provider: Provider = { name: "fake", async chat() { throw new Error("should not be called"); } };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.equal(result.ok, false);
  assert.match(result.summary, /boom/);
});

test("runAgentLoop routes figma_ tool calls to the Figma session, not the local executor", async () => {
  const figmaSchema: ToolSchema = { name: "figma_get_code", description: "d", parameters: { type: "object" } };
  let closed = false;
  let calledWith: { name: string; input: Record<string, unknown> } | undefined;
  let toolsSeenByProvider: ToolSchema[] = [];

  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({
    kind: "ready",
    schemas: [figmaSchema],
    call: async (name, input) => {
      calledWith = { name, input };
      return "figma tool result";
    },
    close: async () => {
      closed = true;
    },
  });

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ProviderResponse> {
      toolsSeenByProvider = tools;
      turn++;
      if (turn === 1) {
        return {
          type: "tool_calls",
          calls: [{ id: "1", name: "figma_get_code", input: { nodeId: "1:2" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.deepEqual(calledWith, { name: "get_code", input: { nodeId: "1:2" } });
  assert.ok(toolsSeenByProvider.some((t) => t.name === "figma_get_code"));
  assert.equal(closed, true);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "saw: figma tool result");
});

test("runAgentLoop routes send_document tool calls to the sendDocument callback", async () => {
  let calledWith: { relPath: string; caption: string | undefined } | undefined;
  const sendDocument = async (relPath: string, caption: string | undefined) => {
    calledWith = { relPath, caption };
    return "Dokumen terkirim.";
  };
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return {
          type: "tool_calls",
          calls: [{ id: "1", name: "send_document", input: { path: "FSD.md", caption: "ini FSD-nya" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn, sendDocument }));

  assert.deepEqual(calledWith, { relPath: "FSD.md", caption: "ini FSD-nya" });
  assert.equal(result.ok, true);
  assert.equal(result.summary, "saw: Dokumen terkirim.");
});

test("runAgentLoop injects extraSystemNotes as system messages after the main prompt, before the user turn", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });
  let seen: ChatMessage[] = [];
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      seen = messages;
      return { type: "text", text: "done" };
    },
  };

  await runAgentLoop(
    baseParams({
      providers: [provider],
      resolveFigmaToolsFn,
      systemPrompt: "MAIN",
      instruction: "USER",
      extraSystemNotes: ["RETRIEVED CODE", "  ", ""],
    })
  );

  assert.deepEqual(
    seen.map((m) => `${m.role}:${m.content}`),
    ["system:MAIN", "system:RETRIEVED CODE", "user:USER"]
  );
});

test("runAgentLoop falls back to a stub message for send_document when no callback was given", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { type: "tool_calls", calls: [{ id: "1", name: "send_document", input: { path: "FSD.md" } }] };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.match(result.summary, /belum tersedia/);
});

test("runAgentLoop asks onDangerousBash before running a flagged command, and skips it when denied", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });
  let askedWith: { command: string; reason: string } | undefined;

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { type: "tool_calls", calls: [{ id: "1", name: "bash", input: { command: "sudo rm x" } }] };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const onDangerousBash = async (command: string, reason: string) => {
    askedWith = { command, reason };
    return false; // denied
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn, onDangerousBash }));

  assert.deepEqual(askedWith, { command: "sudo rm x", reason: "eskalasi privilege lewat sudo" });
  assert.equal(result.ok, true);
  assert.match(result.summary, /saw: Error: command ini butuh persetujuan/);
});

test("runAgentLoop actually runs a flagged bash command once onDangerousBash approves it", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { type: "tool_calls", calls: [{ id: "1", name: "bash", input: { command: "sudo echo hi" } }] };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const result = await runAgentLoop(
    baseParams({ providers: [provider], resolveFigmaToolsFn, onDangerousBash: async () => true })
  );

  assert.equal(result.ok, true);
  assert.match(result.summary, /exit_code:/); // actually reached executeTool, not the denial message
});

test("runAgentLoop denies a flagged bash command by default when onDangerousBash isn't wired", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { type: "tool_calls", calls: [{ id: "1", name: "bash", input: { command: "sudo echo hi" } }] };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.match(result.summary, /saw: Error: command ini butuh persetujuan/);
});

test("runAgentLoop never asks onDangerousBash for an ordinary bash command", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });
  let asked = false;

  let turn = 0;
  const provider: Provider = {
    name: "fake",
    async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { type: "tool_calls", calls: [{ id: "1", name: "bash", input: { command: "echo hi" } }] };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      return { type: "text", text: `saw: ${toolMessage?.content}` };
    },
  };

  const onDangerousBash = async () => {
    asked = true;
    return true;
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn, onDangerousBash }));

  assert.equal(asked, false);
  assert.match(result.summary, /exit_code:/);
});

test("runAgentLoop skips Figma resolution entirely when there's nothing Figma-related", async () => {
  let resolveCalled = false;
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => {
    resolveCalled = true;
    return { kind: "none" };
  };
  const provider: Provider = {
    name: "fake",
    async chat(): Promise<ProviderResponse> {
      return { type: "text", text: "done" };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.equal(resolveCalled, true);
  assert.equal(result.ok, true);
});

test("runAgentLoop retries the same provider on a 429 instead of immediately falling back", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });
  const progressMessages: string[] = [];

  let calls = 0;
  const provider: Provider = {
    name: "gemini",
    async chat(): Promise<ProviderResponse> {
      calls++;
      if (calls === 1) {
        throw new ProviderError("gemini", "quota exceeded", undefined, 429);
      }
      return { type: "text", text: "done after retry" };
    },
  };

  const result = await runAgentLoop(
    baseParams({
      providers: [provider],
      resolveFigmaToolsFn,
      onProgress: async (text) => {
        progressMessages.push(text);
      },
    })
  );

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "done after retry");
  assert.ok(progressMessages.some((m) => /kena limit/.test(m)));
});

test("runAgentLoop falls back to the next provider once 429 retries on the current one are exhausted", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  let firstCalls = 0;
  const flaky: Provider = {
    name: "gemini",
    async chat(): Promise<ProviderResponse> {
      firstCalls++;
      throw new ProviderError("gemini", "quota exceeded", undefined, 429);
    },
  };
  const backup: Provider = {
    name: "qwen",
    async chat(): Promise<ProviderResponse> {
      return { type: "text", text: "done via backup" };
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [flaky, backup], resolveFigmaToolsFn }));

  // 1 initial attempt + 2 retries (RATE_LIMIT_MAX_RETRIES) before giving up on this provider
  assert.equal(firstCalls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "done via backup");
});

test("runAgentLoop reports a model switch, not a key switch, when the next entry shares a name but not a model", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });
  const progressMessages: string[] = [];

  let calls = 0;
  const primaryModel: Provider = {
    name: "gemini",
    model: "gemini-3.1-flash-lite",
    async chat(): Promise<ProviderResponse> {
      calls++;
      throw new ProviderError("gemini", "quota exceeded", undefined, 429);
    },
  };
  const fallbackModel: Provider = {
    name: "gemini",
    model: "gemini-3.5-flash-lite",
    async chat(): Promise<ProviderResponse> {
      return { type: "text", text: "done on fallback model" };
    },
  };

  const result = await runAgentLoop(
    baseParams({
      providers: [primaryModel, fallbackModel],
      resolveFigmaToolsFn,
      onProgress: async (text) => {
        progressMessages.push(text);
      },
    })
  );

  // 1 initial attempt + 2 retries exhausted on the primary model before moving on
  assert.equal(calls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "done on fallback model");
  assert.ok(progressMessages.some((m) => /Model "gemini-3\.1-flash-lite" lagi kena limit/.test(m)));
  assert.ok(!progressMessages.some((m) => /API key/.test(m)));
});

test("runAgentLoop fails the task when a 429 exhausts retries and there's no other provider", async () => {
  const resolveFigmaToolsFn = async (): Promise<FigmaToolsResult> => ({ kind: "none" });

  const provider: Provider = {
    name: "gemini",
    async chat(): Promise<ProviderResponse> {
      throw new ProviderError("gemini", "quota exceeded", undefined, 429);
    },
  };

  const result = await runAgentLoop(baseParams({ providers: [provider], resolveFigmaToolsFn }));

  assert.equal(result.ok, false);
  assert.match(result.summary, /Semua opsi AI lagi gak bisa dipakai/);
});
