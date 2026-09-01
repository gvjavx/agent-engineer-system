import assert from "node:assert/strict";
import { test } from "node:test";
import { tryEvaluateArithmetic } from "./calc.js";

test("evaluates the transcript examples correctly", () => {
  assert.equal(tryEvaluateArithmetic("berapa 234 x 213?"), "234 × 213 = 49.842");

  // real transcript: the model answered this with 14.412.062.822,78 (~3M off)
  const big = tryEvaluateArithmetic("berapa 138482 x 13838432 : 133 - 2432");
  assert.ok(big?.startsWith("138482 × 13838432 ÷ 133 - 2432 = 14.408.822.682"), big);
  assert.ok(!big?.includes("14.412"));
});

test("respects operator precedence and parentheses", () => {
  assert.equal(tryEvaluateArithmetic("2 + 3 * 4"), "2 + 3 × 4 = 14");
  assert.equal(tryEvaluateArithmetic("(2 + 3) * 4"), "(2 + 3) × 4 = 20");
  assert.equal(tryEvaluateArithmetic("10 - 2 - 3"), "10 - 2 - 3 = 5"); // left-assoc
});

test("handles phone-typed operator glyphs and a leading '='", () => {
  assert.equal(tryEvaluateArithmetic("100 : 4"), "100 ÷ 4 = 25");
  assert.equal(tryEvaluateArithmetic("6 ÷ 2 × 3"), "6 ÷ 2 × 3 = 9");
  assert.equal(tryEvaluateArithmetic("= 7*8"), "7 × 8 = 56");
});

test("handles unary minus", () => {
  assert.equal(tryEvaluateArithmetic("-5 + 3"), "-5 + 3 = -2");
  assert.equal(tryEvaluateArithmetic("3 * -2"), "3 × -2 = -6");
});

test("formats decimals in id-ID style", () => {
  assert.equal(tryEvaluateArithmetic("10 / 8"), "10 ÷ 8 = 1,25");
  assert.equal(tryEvaluateArithmetic("1 / 3"), "1 ÷ 3 = 0,333333");
});

test("reports division by zero instead of returning Infinity", () => {
  assert.equal(tryEvaluateArithmetic("5 / 0"), "Nggak bisa diitung — kayaknya ada pembagian sama nol di situ.");
});

test("returns undefined for anything that isn't a clean expression", () => {
  assert.equal(tryEvaluateArithmetic("halo"), undefined);
  assert.equal(tryEvaluateArithmetic("apa kabar"), undefined);
  assert.equal(tryEvaluateArithmetic("berapa harga sewa ruko"), undefined);
  assert.equal(tryEvaluateArithmetic("berapa 5"), undefined); // bare number, nothing to compute
  assert.equal(tryEvaluateArithmetic("5 bagi 2"), undefined); // word operators not supported
  assert.equal(tryEvaluateArithmetic(""), undefined);
  assert.equal(tryEvaluateArithmetic("2 +"), undefined);
  assert.equal(tryEvaluateArithmetic("2 3 4"), undefined);
});

test("skips numbers that look like dotted thousands rather than guessing decimal", () => {
  assert.equal(tryEvaluateArithmetic("1.000 + 500"), undefined);
  assert.equal(tryEvaluateArithmetic("138.482 x 2"), undefined);
});
