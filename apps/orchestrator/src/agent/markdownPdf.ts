import pdfMake from "pdfmake";
import vfsFonts from "pdfmake/build/vfs_fonts.js";
import { marked, type Token, type Tokens } from "marked";

// Markdown -> PDF with no headless browser. pdfmake is pure JS (pdfkit under
// the hood), so this works on a dev laptop and the Linux server alike —
// unlike the @sparticuz/chromium path the screenshot command uses, which only
// runs on the server. Fidelity is lower than a browser render (no CSS), but
// for reports/proposals/letters that's fine.

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  for (const [name, b64] of Object.entries(vfsFonts)) {
    pdfMake.virtualfs.writeFileSync(name, Buffer.from(b64, "base64"));
  }
  pdfMake.setFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  });
  // No document should ever pull a remote or local file while rendering.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(() => false);
  fontsReady = true;
}

type Mark = { bold?: boolean; italics?: boolean; color?: string; link?: string; background?: string };
type Run = string | ({ text: string } & Mark);

function withMark(runs: Run[], mark: Mark): Run[] {
  return runs.map((r) => (typeof r === "string" ? { text: r, ...mark } : { ...r, ...mark }));
}

function inlineRuns(tokens: Token[] | undefined, fallback: string): Run[] {
  if (!tokens || tokens.length === 0) return fallback ? [fallback] : [];
  const out: Run[] = [];
  for (const t of tokens as (Token & { tokens?: Token[]; text?: string })[]) {
    switch (t.type) {
      case "strong":
        out.push(...withMark(inlineRuns(t.tokens, t.text ?? ""), { bold: true }));
        break;
      case "em":
        out.push(...withMark(inlineRuns(t.tokens, t.text ?? ""), { italics: true }));
        break;
      case "codespan":
        out.push({ text: (t as Tokens.Codespan).text, background: "#f0f0f0" });
        break;
      case "link":
        out.push(...withMark(inlineRuns(t.tokens, t.text ?? ""), { color: "#2a6ebb", link: (t as Tokens.Link).href }));
        break;
      case "br":
        out.push("\n");
        break;
      case "del":
        out.push(...inlineRuns(t.tokens, t.text ?? ""));
        break;
      case "text":
        out.push(...(t.tokens ? inlineRuns(t.tokens, t.text ?? "") : [t.text ?? ""]));
        break;
      default:
        if (t.text) out.push(t.text);
    }
  }
  return out;
}

function listItemNode(item: Tokens.ListItem): unknown {
  const runs: Run[] = [];
  const nested: unknown[] = [];
  for (const t of item.tokens as (Token & { tokens?: Token[]; text?: string })[]) {
    if (t.type === "list") {
      const l = t as Tokens.List;
      nested.push({ [l.ordered ? "ol" : "ul"]: l.items.map(listItemNode) });
    } else if (t.type === "text" || t.type === "paragraph") {
      runs.push(...inlineRuns(t.tokens, t.text ?? ""));
    } else if (t.text) {
      runs.push(t.text);
    }
  }
  return nested.length === 0 ? { text: runs } : { stack: [{ text: runs }, ...nested] };
}

const HEADING_SIZE = [19, 16, 14, 12, 11, 11];

function blocksToContent(tokens: Token[]): unknown[] {
  const content: unknown[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const h = tok as Tokens.Heading;
        content.push({
          text: inlineRuns(h.tokens, h.text),
          fontSize: HEADING_SIZE[h.depth - 1] ?? 11,
          bold: true,
          margin: [0, h.depth === 1 ? 2 : 10, 0, 6],
        });
        break;
      }
      case "paragraph": {
        const p = tok as Tokens.Paragraph;
        content.push({ text: inlineRuns(p.tokens, p.text), margin: [0, 0, 0, 8] });
        break;
      }
      case "list": {
        const l = tok as Tokens.List;
        content.push({ [l.ordered ? "ol" : "ul"]: l.items.map(listItemNode), margin: [0, 0, 0, 8] });
        break;
      }
      case "blockquote": {
        const b = tok as Tokens.Blockquote;
        const runs: Run[] = [];
        for (const t of b.tokens as (Token & { tokens?: Token[]; text?: string })[]) {
          runs.push(...inlineRuns(t.tokens, t.text ?? ""), "\n");
        }
        content.push({ text: runs, italics: true, color: "#555", margin: [12, 0, 0, 8] });
        break;
      }
      case "code": {
        const c = tok as Tokens.Code;
        content.push({ text: c.text, fontSize: 9, background: "#f4f4f4", preserveLeadingSpaces: true, margin: [0, 0, 0, 8] });
        break;
      }
      case "table": {
        const t = tok as Tokens.Table;
        content.push({
          table: {
            headerRows: 1,
            widths: t.header.map(() => "*"),
            body: [
              t.header.map((cell) => ({ text: inlineRuns(cell.tokens, cell.text), bold: true })),
              ...t.rows.map((row) => row.map((cell) => ({ text: inlineRuns(cell.tokens, cell.text) }))),
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 8],
        });
        break;
      }
      case "hr":
        content.push({
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#bbbbbb" }],
          margin: [0, 4, 0, 10],
        });
        break;
      case "space":
        break;
      default:
        if ("text" in tok && tok.text) content.push({ text: String(tok.text), margin: [0, 0, 0, 8] });
    }
  }
  return content;
}

export async function markdownToPdf(md: string): Promise<Buffer> {
  ensureFonts();
  const docDefinition = {
    content: blocksToContent(marked.lexer(md)),
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.35 },
    pageMargins: [56, 56, 56, 64],
  };
  return pdfMake.createPdf(docDefinition).getBuffer();
}
