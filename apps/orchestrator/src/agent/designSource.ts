import { extractFigmaFileRefs } from "./mcp/figmaLink.js";
import { IMAGE_DESCRIPTION_MARKER } from "./imageDescription.js";

// Shared by systemPrompt.ts (the desain phase's "ask first" instruction) and
// pipeline.ts (checkpoint options selection — see DESAIN_SOURCE_UPLOAD_IMAGE_TAP)
// — kept in its own neutral file so neither has to import the other
// (pipeline.ts already imports buildPhaseSystemPrompt from systemPrompt.ts,
// so the reverse import would be circular).
export function hasDesignSource(instruction: string): boolean {
  return extractFigmaFileRefs(instruction).length > 0 || instruction.includes(IMAGE_DESCRIPTION_MARKER);
}
