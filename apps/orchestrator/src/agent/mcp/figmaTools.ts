// Thin orchestration between the agent loop and the Figma-specific pieces
// (link detection, OAuth token, MCP client) — kept separate from loop.ts so
// it's injectable as a DI seam there (same pattern as pipeline.ts's
// buildProvidersFn/runTaskFn), and so loop.ts stays Figma-agnostic.
import { auditLog } from "../../db/index.js";
import { extractFigmaFileRefs } from "./figmaLink.js";
import { getValidAccessToken } from "./figmaAuth.js";
import { connectFigmaMcp } from "./figmaClient.js";
import type { ToolSchema } from "../types.js";

export type FigmaToolsResult =
  | { kind: "none" }
  | { kind: "not_linked" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      schemas: ToolSchema[];
      call: (originalName: string, input: Record<string, unknown>) => Promise<string>;
      close: () => Promise<void>;
    };

export async function resolveFigmaTools(instruction: string, taskId: string): Promise<FigmaToolsResult> {
  if (extractFigmaFileRefs(instruction).length === 0) {
    return { kind: "none" };
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { kind: "not_linked" };
  }

  try {
    const session = await connectFigmaMcp(accessToken);
    if (session.skippedToolNames.length > 0) {
      auditLog.add(
        taskId,
        "note",
        `Figma MCP nawarin tool yang belum di-allowlist (dilewatin, gak dipanggil): ${session.skippedToolNames.join(", ")}`
      );
    }
    return { kind: "ready", schemas: session.schemas, call: session.callTool, close: session.close };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
