// Figma links pasted straight into a WhatsApp instruction are how the user
// points the agent at a file/frame — no separate registration step. This
// just extracts what we need from the URL text; it doesn't touch the network.

export interface FigmaFileRef {
  url: string;
  fileKey: string;
  nodeId?: string;
}

const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)[^\s]*/g;

export function extractFigmaFileRefs(instruction: string): FigmaFileRef[] {
  const refs: FigmaFileRef[] = [];
  for (const match of instruction.matchAll(FIGMA_URL_RE)) {
    const url = match[0];
    const fileKey = match[1];
    let nodeId: string | undefined;
    try {
      nodeId = new URL(url).searchParams.get("node-id") ?? undefined;
    } catch {
      // malformed trailing punctuation etc. — fileKey is still usable without node-id
    }
    refs.push({ url, fileKey, nodeId });
  }
  return refs;
}
