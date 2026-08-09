import assert from "node:assert/strict";
import { test } from "node:test";
import { mapReadOnlyTools, stringifyToolResult, type McpToolInfo } from "./figmaClient.js";

test("mapReadOnlyTools keeps only get_* tools and prefixes them", () => {
  const tools: McpToolInfo[] = [
    { name: "get_code", description: "Generate code from a node", inputSchema: { type: "object" } },
    { name: "get_image", inputSchema: { type: "object" } },
    { name: "create_frame", inputSchema: { type: "object" } },
    { name: "update_variable", inputSchema: { type: "object" } },
  ];

  const { schemas, skippedToolNames } = mapReadOnlyTools(tools);

  assert.deepEqual(
    schemas.map((s) => s.name),
    ["figma_get_code", "figma_get_image"]
  );
  assert.equal(schemas[0].description, "Generate code from a node");
  assert.equal(schemas[1].description, "Figma MCP tool: get_image");
  assert.deepEqual(skippedToolNames, ["create_frame", "update_variable"]);
});

test("mapReadOnlyTools returns nothing when the server offers no read tools", () => {
  const tools: McpToolInfo[] = [{ name: "create_frame", inputSchema: { type: "object" } }];
  const { schemas, skippedToolNames } = mapReadOnlyTools(tools);
  assert.deepEqual(schemas, []);
  assert.deepEqual(skippedToolNames, ["create_frame"]);
});

test("stringifyToolResult joins text blocks", () => {
  const text = stringifyToolResult({ content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] });
  assert.equal(text, "hello\nworld");
});

test("stringifyToolResult notes image blocks without dumping base64 data", () => {
  const text = stringifyToolResult({ content: [{ type: "image", data: "verylongbase64....", mimeType: "image/png" }] });
  assert.equal(text, "[image returned: image/png]");
  assert.ok(!text.includes("verylongbase64"));
});
