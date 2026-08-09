import path from "node:path";

// Allowlist, not blocklist — same default-deny principle as the Figma MCP
// tool filter. Only extensions we know WhatsApp handles as a document and
// that are plausible deliverables for this project (reports, specs, exports).
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".zip": "application/zip",
};

export function resolveDocumentMimeType(filename: string): string | undefined {
  return MIME_TYPES_BY_EXTENSION[path.extname(filename).toLowerCase()];
}

// Base64-over-JSON through the internal orchestrator->gateway call, not a
// stream — keeping this well under WhatsApp's own 100MB document ceiling.
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
