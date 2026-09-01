// A deterministic evaluator for plain arithmetic typed into casual chat
// ("berapa 234 x 213?"). The chat path is a bare LLM text call with no
// tools, and a free-tier model quietly gets multi-digit arithmetic wrong —
// real transcript: it answered "138482 x 13838432 : 133 - 2432" with a
// number ~3 million off, plus invented decimal places. Anything that isn't a
// clean expression returns undefined and falls through to the model as before.
//
// ponytail: symbol operators only (+ - * / and the x / : / ×  ÷ forms typed
// on a phone) — no "dibagi"/"kali" word forms. A number written with a
// 3-digit group after a dot (1.000, 138.482) is ambiguous thousands-vs-
// decimal, so the whole expression is skipped rather than guessed at.

const LEAD_RE = /^(?:berapa(?:kah)?|hitung(?:kan)?|itung|brp|jumlah(?:kan)?)\s+/i;
const AMBIGUOUS_THOUSANDS_RE = /\d\.\d{3}(?!\d)/;
const EXPR_CHARS_RE = /^[\d\s.+\-*/xX×:÷()]+$/;

type Token =
  | { type: "num"; value: number }
  | { type: "op"; value: "+" | "-" | "*" | "/" | "u-" }
  | { type: "paren"; value: "(" | ")" };

const PREC: Record<Exclude<Token["value"], "(" | ")">, number> = { "u-": 4, "*": 3, "/": 3, "+": 2, "-": 2 };
const RIGHT_ASSOC = new Set(["u-"]);

export function tryEvaluateArithmetic(message: string): string | undefined {
  let expr = message.trim().replace(LEAD_RE, "").replace(/^=\s*/, "").trim();
  expr = expr.replace(/\?+$/g, "").trim();
  if (expr.length === 0 || !EXPR_CHARS_RE.test(expr) || AMBIGUOUS_THOUSANDS_RE.test(expr)) return undefined;

  const normalized = expr.replace(/[xX×]/g, "*").replace(/[:÷]/g, "/");
  // A bare number (or something with no operator between values) isn't a
  // calculation — let the model handle "berapa 5" or "berapa nomor kamu".
  if (!/\d[\s)]*[+\-*/]/.test(normalized)) return undefined;

  let tokens: Token[];
  let value: number;
  try {
    tokens = tokenize(normalized);
    value = evalRpn(toRpn(tokens));
  } catch {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return "Nggak bisa diitung — kayaknya ada pembagian sama nol di situ.";
  }

  return `${renderExpr(tokens)} = ${formatNumber(value)}`;
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let j = i + 1;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      const numStr = s.slice(i, j);
      if ((numStr.match(/\./g) ?? []).length > 1) throw new Error("bad number");
      const n = Number(numStr);
      if (!Number.isFinite(n)) throw new Error("bad number");
      tokens.push({ type: "num", value: n });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      const prev = tokens[tokens.length - 1];
      const atValuePosition = !prev || prev.type === "op" || (prev.type === "paren" && prev.value === "(");
      if (atValuePosition && (ch === "+" || ch === "-")) {
        if (ch === "-") tokens.push({ type: "op", value: "u-" }); // unary + is a no-op
      } else {
        tokens.push({ type: "op", value: ch });
      }
      i++;
      continue;
    }
    throw new Error(`unexpected char ${ch}`);
  }
  return tokens;
}

function toRpn(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const stack: Token[] = [];
  for (const t of tokens) {
    if (t.type === "num") {
      out.push(t);
    } else if (t.type === "op") {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.type !== "op") break;
        const pop = PREC[top.value] > PREC[t.value] || (PREC[top.value] === PREC[t.value] && !RIGHT_ASSOC.has(t.value));
        if (!pop) break;
        out.push(stack.pop()!);
      }
      stack.push(t);
    } else if (t.value === "(") {
      stack.push(t);
    } else {
      let matched = false;
      while (stack.length) {
        const top = stack.pop()!;
        if (top.type === "paren" && top.value === "(") {
          matched = true;
          break;
        }
        out.push(top);
      }
      if (!matched) throw new Error("mismatched parens");
    }
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top.type === "paren") throw new Error("mismatched parens");
    out.push(top);
  }
  return out;
}

function evalRpn(rpn: Token[]): number {
  const st: number[] = [];
  for (const t of rpn) {
    if (t.type === "num") {
      st.push(t.value);
      continue;
    }
    if (t.type !== "op") throw new Error("bad token");
    if (t.value === "u-") {
      const a = st.pop();
      if (a === undefined) throw new Error("bad expr");
      st.push(-a);
      continue;
    }
    const b = st.pop();
    const a = st.pop();
    if (a === undefined || b === undefined) throw new Error("bad expr");
    st.push(t.value === "+" ? a + b : t.value === "-" ? a - b : t.value === "*" ? a * b : a / b);
  }
  if (st.length !== 1) throw new Error("bad expr");
  return st[0];
}

// Echo the expression back with tidy glyphs (× ÷) and spacing, rebuilt from
// the parsed tokens so unary minus stays attached to its number.
function renderExpr(tokens: Token[]): string {
  const BINARY = { "+": "+", "-": "-", "*": "×", "/": "÷" } as const;
  let s = "";
  for (const t of tokens) {
    if (t.type === "num") s += String(t.value);
    else if (t.type === "paren") s += t.value;
    else if (t.value === "u-") s += "-";
    else s += ` ${BINARY[t.value]} `;
  }
  return s.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();
}

function formatNumber(n: number): string {
  // Intl already rounds to the fraction-digit cap; an extra Math.round(n*1e6)
  // pre-round would overflow past 2^53 for large results and corrupt them.
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 6 }).format(n);
}
