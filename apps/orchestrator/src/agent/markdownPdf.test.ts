import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPdf } from "./markdownPdf.js";

test("markdownToPdf renders a document with headings, lists, tables, and inline styles to a real PDF", async () => {
  const md = [
    "# Proposal Kerjasama",
    "",
    "Paragraf pembuka dengan **teks tebal**, _miring_, `kode`, dan [tautan](https://example.com). Café, naïve.",
    "",
    "## Rincian",
    "",
    "- poin satu",
    "- poin dua",
    "  - sub-poin",
    "",
    "1. langkah pertama",
    "2. langkah kedua",
    "",
    "> Catatan penting di sini.",
    "",
    "| Item | Qty |",
    "| --- | --- |",
    "| Beras | 10 |",
    "| Gula | 5 |",
    "",
    "```",
    "kode blok",
    "```",
    "",
    "---",
    "",
    "Penutup.",
  ].join("\n");

  const buf = await markdownToPdf(md);
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(buf.length > 2000, `expected a non-trivial PDF, got ${buf.length} bytes`);
});

test("markdownToPdf handles plain text with no markdown structure", async () => {
  const buf = await markdownToPdf("cuma satu baris teks biasa");
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
});
