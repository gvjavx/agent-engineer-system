// Ranked list of token pairs that keep differing between a chat question and
// a near-miss stored one — candidates for the SYNONYM map in db/chatKb.ts.
//
//   npx tsx scripts/kb-synonym-hints.ts [minCount]

import { kbHintsRepo } from "../src/db/chatKb.js";

const rows = kbHintsRepo.top(Number(process.argv[2] ?? 2), 100);
if (rows.length === 0) {
  console.log("No hints yet — they accrue on near-miss lookups while CHAT_KB_ENABLED.");
} else {
  for (const r of rows) console.log(`${String(r.count).padStart(4)}  ${r.a}  <->  ${r.b}`);
}
process.exit(0);
