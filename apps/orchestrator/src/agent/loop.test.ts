import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "./loop.js";
import type { FigmaToolsResult } from "./mcp/figmaTools.js";
import type { Provider, ToolSchema, ChatMessage, ProviderResponse } from "./types.js";

function baseParams(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return {
    providers: [] as Provider[],
    systemPrompt: "system",
    instruction: "do something",
    cwd: "/does/not/matter",
    taskId: "test-task",
    abortController: new AbortController(),
    onProgress: () => {},
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
  assert.match(result.summary, /hubungkan figma/);
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
