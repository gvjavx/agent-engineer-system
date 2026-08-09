import assert from "node:assert/strict";
import { test } from "node:test";
import { toOpenAiMessages, toOpenAiTools } from "./openAiCompatible.js";
import type { ChatMessage, ToolSchema } from "../types.js";

test("toOpenAiMessages converts system/user/tool turns and assistant tool_calls", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "you are an agent" },
    { role: "user", content: "add a health endpoint" },
    {
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "bash", input: { command: "ls" } }],
    },
    { role: "tool", toolCallId: "call_1", toolName: "bash", content: "exit_code: 0" },
    { role: "assistant", content: "Done." },
  ];

  const openAiMessages = toOpenAiMessages(messages);

  assert.equal(openAiMessages.length, 5);
  assert.deepEqual(openAiMessages[0], { role: "system", content: "you are an agent" });
  assert.deepEqual(openAiMessages[1], { role: "user", content: "add a health endpoint" });
  assert.deepEqual(openAiMessages[2], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
  });
  assert.deepEqual(openAiMessages[3], { role: "tool", tool_call_id: "call_1", content: "exit_code: 0" });
  assert.deepEqual(openAiMessages[4], { role: "assistant", content: "Done." });
});

test("toOpenAiTools maps ToolSchema to function-typed tools", () => {
  const tools: ToolSchema[] = [
    { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } },
  ];

  const openAiTools = toOpenAiTools(tools);

  assert.deepEqual(openAiTools, [
    { type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } },
  ]);
});
