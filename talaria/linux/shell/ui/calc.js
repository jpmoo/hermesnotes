/*
 * Arithmetic for the writing surface, in the notation Calca uses.
 *
 * There is a small family of these — Soulver, Numi, Calca, Tydlig — and only
 * one of them has a *notation* rather than a document format: Calca's files are
 * Markdown, a line reading `rent = 1850` names a value, and a line containing
 * `=>` is evaluated with the answer written after it. That is the whole
 * convention, it is legible to somebody who has never heard of it, and it
 * survives being opened in anything. So it is the one worth copying, because
 * this surface's documents are plain files first.
 *
 * **No `eval`, and not for the usual reason.** The text being evaluated is the
 * user's own, so this is not a sandbox story — it is that `eval` would accept
 * far more than arithmetic and then behave in ways nobody can predict from
 * looking at the line. A parser that knows six operators can only ever do those
 * six things, and can say precisely what it did not understand.
 */

/** What a name may be called. Deliberately narrow: one word, no spaces. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

const FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (n, places = 0) => {
    const scale = 10 ** places;
    return Math.round(n * scale) / scale;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
};

/** Everything the parser will be handed, as tokens. */
function scan(source) {
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const ch = source[at];

    if (/\s/.test(ch)) { at += 1; continue; }

    /*
     * A number, with commas allowed as the thousands separator somebody would
     * actually type — but only in groups of exactly three.
     *
     * The first version took any comma after a digit, so `max(3, 9, 2)` scanned
     * as the single number `3` having swallowed its own argument separator, and
     * the call fell over complaining about a bracket. Grouping is what makes
     * `1,234` a number and `3, 9` two of them.
     *
     * One ambiguity survives and is worth knowing: inside a call, `max(1,234)`
     * is one argument of 1234 rather than two. Write function arguments without
     * separators.
     */
    const number = /^\d{1,3}(,\d{3})+(\.\d+)?|^\d+(\.\d+)?|^\.\d+/.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0].replace(/,/g, "")) });
      at += number[0].length;
      continue;
    }

    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: "name", value: name[0] });
      at += name[0].length;
      continue;
    }

    // `×` and `÷` because they are what a person writes when they are writing
    // rather than programming, and this is a writing surface.
    if ("+-*/^%(),×÷".includes(ch)) {
      const value = ch === "×" ? "*" : ch === "÷" ? "/" : ch;
      tokens.push({ kind: value, value });
      at += 1;
      continue;
    }

    throw new Error(`can't read “${ch}”`);
  }
  return tokens;
}

/**
 * The tokens, as a number.
 *
 * A plain recursive descent, precedence low to high: sum, product, power,
 * sign, percent, atom. `^` binds right so `2^3^2` is 512, which is what it
 * means everywhere outside a spreadsheet.
 */
function parse(tokens, scope) {
  let at = 0;
  const peek = () => tokens[at];
  const take = (kind) => (tokens[at]?.kind === kind ? (at += 1, true) : false);

  function sum() {
    let left = product();
    for (;;) {
      if (take("+")) left += product();
      else if (take("-")) left -= product();
      else return left;
    }
  }

  function product() {
    let left = power();
    for (;;) {
      if (take("*")) left *= power();
      else if (take("/")) {
        const by = power();
        if (by === 0) throw new Error("divided by zero");
        left /= by;
      } else return left;
    }
  }

  function power() {
    const base = sign();
    if (take("^")) return base ** power();
    return base;
  }

  function sign() {
    if (take("-")) return -sign();
    if (take("+")) return sign();
    return percent();
  }

  function percent() {
    let value = atom();
    // Postfix, and it means exactly "divided by a hundred". Soulver reads
    // `20 + 10%` as 22 — ten percent *of the left side* — which is a lovely
    // shorthand and an ambiguity: the same line means 20.1 under the reading
    // every calculator uses. A writing surface should not guess between those.
    while (take("%")) value /= 100;
    return value;
  }

  function atom() {
    const token = peek();
    if (!token) throw new Error("the line stops early");

    if (take("(")) {
      const value = sum();
      if (!take(")")) throw new Error("a bracket is not closed");
      return value;
    }

    if (token.kind === "number") { at += 1; return token.value; }

    if (token.kind === "name") {
      at += 1;
      const fn = FUNCTIONS[token.value];
      if (fn && peek()?.kind === "(") {
        at += 1;
        const args = [];
        if (peek()?.kind !== ")") {
          args.push(sum());
          while (take(",")) args.push(sum());
        }
        if (!take(")")) throw new Error("a bracket is not closed");
        return fn(...args);
      }
      if (Object.prototype.hasOwnProperty.call(scope, token.value)) return scope[token.value];
      throw new Error(`nothing called “${token.value}” yet`);
    }

    throw new Error(`“${token.value}” doesn't belong there`);
  }

  const value = sum();
  if (at < tokens.length) throw new Error(`“${tokens[at].value}” doesn't belong there`);
  return value;
}

/**
 * A number, written the way somebody would write it.
 *
 * Floating point makes `0.1 + 0.2` into `0.30000000000000004`, and a writing
 * surface showing that has said something false about the arithmetic rather
 * than something true about binary. Twelve significant figures is past anything
 * a person types and short of where the noise begins.
 */
export function show(value) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  if (Number.isInteger(rounded)) return String(rounded);
  return String(Number(rounded.toFixed(6)));
}

/** One expression, against the names defined above it. Throws with a sentence. */
export function evaluate(source, scope = {}) {
  const text = String(source).trim();
  if (!text) throw new Error("nothing to work out");
  return parse(scan(text), scope);
}

/**
 * A line, read.
 *
 * Returns what the line *is* — a definition, a question, or prose — without
 * evaluating anything, so the caller can decide what to do about it. The three
 * shapes are the whole notation:
 *
 *   rent = 1850              a name, and what it holds
 *   rent * 12 =>             a question; the answer is written after the arrow
 *   rent = 1850 => 1850      both at once, which is what Calca writes
 *
 * `=>` is required for a bare expression on purpose. Every other line in the
 * document is prose, and a surface that tried to evaluate prose would put an
 * answer beside a sentence that merely contained a number.
 */
/**
 * Whether a head of a line is plausibly a sum at all.
 *
 * `=>` is not rare in prose — it turns up in notes about implication, in
 * quoted code, in an arrow somebody drew — and the first version answered
 * "A sentence with an arrow => that is not arithmetic" with *nothing called “A”
 * yet*, which is a calculator defacing a sentence. So a question has to carry an
 * operator, or be a single term, before it is treated as one. A typo in a real
 * sum falls through this and simply gets no answer, which is the quieter way to
 * be wrong.
 */
export function looksArithmetic(head) {
  const text = String(head).trim();
  if (!text) return false;
  if (/[+\-*/^%×÷()]/.test(text)) return true;
  return /^[\d.,]+$/.test(text) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

export function readLine(text) {
  const line = String(text);
  const arrow = line.indexOf("=>");
  const head = arrow === -1 ? line : line.slice(0, arrow);
  const shown = arrow === -1 ? null : line.slice(arrow + 2);

  // `=` but not `==`, `<=`, `>=` or the arrow itself.
  const eq = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(head);
  if (eq) return { kind: "define", name: eq[1], expression: head.slice(eq[0].length), arrow: arrow !== -1, shown };
  if (arrow !== -1) {
    return looksArithmetic(head)
      ? { kind: "ask", expression: head, arrow: true, shown }
      : { kind: "prose" };
  }
  return { kind: "prose" };
}

/**
 * A document's lines, worked out in order.
 *
 * Order is the whole model: a name means whatever it was last set to *above*
 * the line using it, which is how somebody reading top to bottom would take it.
 * Returns one entry per line — `null` for prose — and never throws: a line that
 * cannot be worked out reports why, in place, and the lines after it carry on.
 */
export function run(lines, { bare = false } = {}) {
  const scope = {};
  return lines.map((text) => {
    let read = readLine(text);
    /*
     * Inside a calculation block every line is a question, because that is what
     * the block is for — a column of workings, not prose with sums in it. A
     * line that turns out not to be arithmetic is left alone rather than
     * decorated with a complaint: a block may hold a heading or a note, and
     * `quiet` is how this says so.
     */
    if (bare && read.kind === "prose" && text.trim()) read = { kind: "ask", expression: text, arrow: false, shown: null, quiet: true };
    if (read.kind === "prose") return null;
    try {
      const value = evaluate(read.expression, scope);
      if (read.kind === "define") scope[read.name] = value;
      return { ...read, value, text: show(value) };
    } catch (err) {
      return { ...read, error: String(err.message || err) };
    }
  });
}
