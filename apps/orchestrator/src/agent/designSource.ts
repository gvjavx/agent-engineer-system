import { IMAGE_DESCRIPTION_MARKER } from "./imageDescription.js";

// Shared by systemPrompt.ts (the desain phase's "ask first" instruction) and
// pipeline.ts (checkpoint options selection — see DESAIN_SOURCE_UPLOAD_IMAGE_TAP)
// — kept in its own neutral file so neither has to import the other
// (pipeline.ts already imports buildPhaseSystemPrompt from systemPrompt.ts,
// so the reverse import would be circular).
//
// A bare Figma link doesn't count — Figma's own OAuth restrictions mean
// nothing can actually read it right now (see handler.ts's
// handleConnectFigmaCommand), so treating it as "source provided" would
// skip the ask-first flow and let a phase run partway before failing deep
// inside the agent loop instead of asking upfront.
export function hasDesignSource(instruction: string): boolean {
  return instruction.includes(IMAGE_DESCRIPTION_MARKER);
}
