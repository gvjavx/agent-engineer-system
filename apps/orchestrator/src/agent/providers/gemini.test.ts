import assert from "node:assert/strict";
import { test } from "node:test";
import { toGeminiContents, toGeminiTools, buildGeminiVisionContents } from "./gemini.js";
import type { ChatMessage, ToolSchema } from "../types.js";

test("toGeminiContents converts user/assistant/tool turns and skips system", () => {
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

  const contents = toGeminiContents(messages);

  assert.equal(contents.length, 4); // system message dropped
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "add a health endpoint" }] });
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [{ functionCall: { id: "call_1", name: "bash", args: { command: "ls" } } }],
  });
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [{ functionResponse: { id: "call_1", name: "bash", response: { output: "exit_code: 0" } } }],
  });
  assert.deepEqual(contents[3], { role: "model", parts: [{ text: "Done." }] });
});

test("toGeminiContents replays thoughtSignature from providerData onto the functionCall part", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "do something" },
    {
      role: "assistant",
      toolCalls: [
        { id: "call_1", name: "bash", input: { command: "ls" }, providerData: { thoughtSignature: "sig-abc" } },
      ],
    },
  ];

  const contents = toGeminiContents(messages);

  assert.deepEqual(contents[1], {
    role: "model",
    parts: [
      { functionCall: { id: "call_1", name: "bash", args: { command: "ls" } }, thoughtSignature: "sig-abc" },
    ],
  });
});

test("toGeminiContents merges consecutive tool results into one turn", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "do two things" },
    {
      role: "assistant",
      toolCalls: [
        { id: "call_1", name: "bash", input: { command: "a" } },
        { id: "call_2", name: "bash", input: { command: "b" } },
      ],
    },
    { role: "tool", toolCallId: "call_1", toolName: "bash", content: "result a" },
    { role: "tool", toolCallId: "call_2", toolName: "bash", content: "result b" },
  ];

  const contents = toGeminiContents(messages);

  assert.equal(contents.length, 3);
  assert.equal(contents[2].role, "user");
  assert.equal(contents[2].parts?.length, 2);
  assert.deepEqual(contents[2].parts?.[0].functionResponse?.id, "call_1");
  assert.deepEqual(contents[2].parts?.[1].functionResponse?.id, "call_2");
});

test("buildGeminiVisionContents builds one user turn with inline image + text parts", () => {
  const contents = buildGeminiVisionContents("aGVsbG8=", "image/jpeg", "describe this");
  assert.deepEqual(contents, [
    {
      role: "user",
      parts: [{ inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } }, { text: "describe this" }],
    },
  ]);
});

test("toGeminiTools maps ToolSchema to functionDeclarations with parametersJsonSchema", () => {
  const tools: ToolSchema[] = [
    { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } },
  ];

  const geminiTools = toGeminiTools(tools);

  assert.equal(geminiTools.length, 1);
  assert.deepEqual(geminiTools[0].functionDeclarations, [
    { name: "bash", description: "run a command", parametersJsonSchema: { type: "object", properties: {} } },
  ]);
});
