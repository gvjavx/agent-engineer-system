import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSchema } from "../types.js";

const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";

// Default-deny, not blocklist: Figma's MCP server also ships tools that
// create/modify canvas content (still beta), and we only agreed to read
// access. Anything not unambiguously a getter stays hidden from the model.
const READ_ONLY_NAME_RE = /^get_/i;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export interface FigmaMcpSession {
  // Exposed to the model as "figma_<original name>" so they're visually
  // distinct from the base bash/read_file/write_file/edit_file tools.
  schemas: ToolSchema[];
  callTool: (originalName: string, input: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
  // Tool names the server offered that we didn't expose (failed the
  // read-only filter) — logged by the caller so a new write tool showing up
  // server-side is visible instead of silently ignored.
  skippedToolNames: string[];
}

export function mapReadOnlyTools(tools: McpToolInfo[]): { schemas: ToolSchema[]; skippedToolNames: string[] } {
  const schemas: ToolSchema[] = [];
  const skippedToolNames: string[] = [];
  for (const tool of tools) {
    if (!READ_ONLY_NAME_RE.test(tool.name)) {
      skippedToolNames.push(tool.name);
      continue;
    }
    schemas.push({
      name: `figma_${tool.name}`,
      description: tool.description ?? `Figma MCP tool: ${tool.name}`,
      parameters: tool.inputSchema as ToolSchema["parameters"],
    });
  }
  return { schemas, skippedToolNames };
}

// ponytail: image content blocks come back as base64 and our tool-result
// channel is plain text fed to a text-only chat loop — the model can't see
// the image anyway, so we just note it was returned instead of spending
// tokens dumping the data. A real fix would need multimodal tool results.
export function stringifyToolResult(result: McpToolResult): string {
  return result.content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[image returned: ${block.mimeType ?? "unknown type"}]`;
      return `[${block.type} content]`;
    })
    .join("\n");
}

export async function connectFigmaMcp(accessToken: string): Promise<FigmaMcpSession> {
  const client = new Client({ name: "mas-ade", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(FIGMA_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const { schemas, skippedToolNames } = mapReadOnlyTools(tools as McpToolInfo[]);

  return {
    schemas,
    skippedToolNames,
    async callTool(originalName, input) {
      const result = await client.callTool({ name: originalName, arguments: input });
      return stringifyToolResult(result as McpToolResult);
    },
    async close() {
      await client.close();
    },
  };
}
