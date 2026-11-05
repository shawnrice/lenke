import { tokenize } from './lexer.js';
import type { Token, TokenType } from './lexer.js';

/**
 * Lift eligible literals out of a query's TEXT into parameters, so that queries differing only in
 * their constants share one cache entry.
 *
 * WHY (items 1499-1501). The parse and plan caches key on the query text, so an application that
 * interpolates values into that text — which is how people write queries before they learn about
 * parameters — misses on every call by construction. Item 1499 priced it: parse+plan is **3.1-6.9x
 * the EXECUTION of a cheap query**, and `bench:usage` has carried the consequence since item 662
 * (`write: append node` 128.6k ops/s against `write: append node [params]` 512.8k, 4x, in the
 * unindexed column where no seek applies). Item 1500 then showed the planner has no hot spot, so
 * skipping parse+plan is the only large win left.
 *
 * ⚠️ THE TEXT IS REWRITTEN, NOT THE AST. `MATCH (n:P) WHERE n.k = 7` becomes
 * `MATCH (n:P) WHERE n.k = $__ap0` with `{ __ap0: 7 }`, and that rewritten text goes through the
 * ordinary `parse` and plan caches unchanged. No AST surgery, no plan surgery, nothing to keep in
 * sync with either — the whole mechanism is a string and an object.
 *
 * ## The eligibility rule is an ALLOWLIST, and item 1501 is why each entry is in it
 *
 * A literal is lifted only when the token immediately before it is a comparison operator or a
 * `colon`. That is deliberately narrow, and it excludes by CONSTRUCTION every position item 1501's
 * gate found unsafe — rather than by enumerating exclusions, which a new syntax arm could slip past:
 *
 *   - **`LIMIT 10` / `SKIP 10`** — the preceding token is a keyword, so it is never lifted.
 *     `topKPlan` (item 1064) reads the limit VALUE at plan time, and item 1501 measured a param
 *     limit at **5.3-6.1x** (52.75 → 322.67 ms) because it loses the bounded top-K walk. This is
 *     the one exception the gate found, and it is the one an allowlist gets right for free.
 *   - **a path quantifier `-[:E]->{1,3}`** — the preceding tokens are `lbrace` and `comma`. Lifting
 *     a quantifier bound would change the pattern the planner compiles, and silently.
 *   - **`DATE '2020-01-01'`** and the other temporal constructors — the preceding token is the
 *     temporal keyword, and `DATE $p` is not the same construct (item 1491's comparison rules live
 *     on the parsed `Temporal`, not on a string).
 *   - **`null`, `true`, `false`** — keywords, not `number`/`string` tokens, so they cannot be
 *     lifted at all. That matters most for null: `{k: null}` means IS NULL for an inline constraint
 *     (item 260) and `IS NULL` has no parameterized spelling whatsoever (item 1501: `= $null`
 *     yields UNKNOWN and matches nothing).
 *
 * Positions the allowlist also declines, conservatively rather than because they are known unsafe:
 * `IN [7, 8]`, arithmetic (`n.k + 1`), function arguments, and anything inside a list or map
 * literal. Item 1501 measured `IN list` at 1.06x and `projection` at 0.77x, so these are candidates
 * for a later widening — each needs its own gate row first.
 *
 * ⚠️ IT RETURNS `undefined` WHEN NOTHING IS ELIGIBLE, and the caller must then use the original
 * text. Rewriting a query that gained no shareable key would be pure cost.
 */

/**
 * ⚠️ ARITHMETIC NEIGHBOURS DISQUALIFY A LITERAL, and a test found this rather than foresight.
 *
 * The reversed-comparison rule below lifts a literal whose NEXT token is a comparison — which also
 * catches the last operand of an arithmetic expression: `WHERE n.k + 1 = 8` became
 * `n.k + $__ap0 = $__ap1`. That is very probably harmless (item 1501 measured a param inside
 * arithmetic at 0.77x in a projection), but "very probably" is the wrong standard for a rewrite of
 * user query text, and it would put the feature outside the positions the gate actually measured.
 * A folded form such as `n.k = 7` would also be unreachable once the operands are opaque.
 *
 * So a literal adjacent to any arithmetic operator is left alone, which makes the documented rule
 * true rather than nearly true.
 */
const ARITHMETIC: ReadonlySet<TokenType> = new Set<TokenType>([
  'plus',
  'dash',
  'star',
  'slash',
  'percent',
  'concat',
]);

/** Comparison operators — a literal on EITHER side of one is a value position. */
const COMPARISONS: ReadonlySet<TokenType> = new Set<TokenType>([
  'eq',
  'neq',
  'lt',
  'gt',
  'lte',
  'gte',
]);

/**
 * Token types that may immediately PRECEDE a liftable literal: a comparison, or a `colon` (an
 * inline property value — `(n:P)`'s label is an identifier, never a literal, so a literal after a
 * colon is always a property value).
 */
const LIFTABLE_AFTER: ReadonlySet<TokenType> = new Set<TokenType>([...COMPARISONS, 'colon']);

/** The result of a successful lift: a reusable text and the values it expects. */
export type Normalized = { text: string; params: Record<string, unknown> };

/**
 * ⚠️ THE SYNTHETIC NAMESPACE IS `__ap<n>`, NOT `p<n>`. The tagged-template form of `gql()` owns
 * `$p0…$pn` and documents that callers must not hand-write those inside a template; colliding with
 * it here would make a template whose substitutions silently take the wrong values. A leading
 * double underscore also keeps these out of the way of the `_`-sigil extension convention.
 */
const NAME_PREFIX = '__ap';

/**
 * The source span of `tokens[i]`, bounded by where the NEXT token starts.
 *
 * ⚠️ A `Token` carries `pos` but no LENGTH, and the two cannot be derived from `value`: a string
 * token's `value` is the DECODED content, so it is shorter than its source by the quotes and by
 * every escape. Using the next token's `pos` as the end is exact for the purpose, and the only
 * thing it can swallow is whitespace or a comment sitting between the two — both of which the lexer
 * discards anyway, so the rewritten text means the same thing.
 */
const spanEnd = (tokens: readonly Token[], i: number, srcLength: number): number =>
  i + 1 < tokens.length ? tokens[i + 1].pos : srcLength;

/**
 * ⚠️ A CHEAP PRE-FILTER, AND IT IS WHAT KEEPS THE COST OFF CALLERS THIS CANNOT HELP (item 1502).
 *
 * Normalization needs a tokenize (~865 ns), and it runs on every parse-cache MISS. Measured, a text
 * that misses for some reason OTHER than a liftable literal paid **1.11-1.27x** for the attempt —
 * and those are real callers, not hypotheses: an interpolated LABEL (`MATCH (n:${'${label}'})`), an
 * interpolated `LIMIT`, or `WHERE n.k IN [${'${ids.join(",")}'}]`, which the allowlist declines.
 *
 * This regex asks the same question the allowlist asks, approximately and without tokenizing: is
 * there a comparison operator or a colon next to something that could START a literal — on EITHER
 * side, so the reversed spelling (`5 <= u.n`) is not filtered out before it is considered? It is
 * deliberately one-sided — a false POSITIVE merely proceeds to the real check, while a false
 * negative would silently stop lifting. So it must stay at least as permissive as
 * {@link LIFTABLE_AFTER}: widen this whenever that set widens.
 */
const MAYBE_LIFTABLE = /[=<>:]\s*-?['"\d]|['"\d]\s*[=<>]/u;

export const normalizeLiterals = (text: string): Normalized | undefined => {
  if (!MAYBE_LIFTABLE.test(text)) {
    return undefined;
  }

  let tokens: readonly Token[];

  try {
    tokens = tokenize(text);
  } catch {
    // A text that does not even lex has nothing to lift; the caller's own parse will raise with the
    // proper error, which is strictly better than anything this could report.
    return undefined;
  }

  let out = '';
  let cursor = 0;
  let n = 0;
  const params: Record<string, unknown> = {};

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    // ⚠️ EITHER SIDE OF A COMPARISON, and the reversed side is not an afterthought: `5 <= u.n` and
    // `u.n >= 5` are the SAME question, and CLAUDE.md names that exact pair as one of the
    // equivalent-spelling defects this engine has shipped before. Lifting only the right-hand side
    // would have left the reversed spelling paying full parse+plan forever — an asymmetry created
    // by the optimisation rather than found by it.
    const isLiteral = tok.type === 'number' || tok.type === 'string';
    const prev = tokens[i - 1].type;
    const next = i + 1 < tokens.length ? tokens[i + 1].type : undefined;
    const liftable =
      isLiteral &&
      !ARITHMETIC.has(prev) &&
      (next === undefined || !ARITHMETIC.has(next)) &&
      (LIFTABLE_AFTER.has(prev) || (next !== undefined && COMPARISONS.has(next)));

    if (!liftable) {
      continue;
    }

    const name = `${NAME_PREFIX}${n}`;

    // A trailing space, because the span may have ended flush against the next token.
    out += `${text.slice(cursor, tok.pos)}$${name} `;
    cursor = spanEnd(tokens, i, text.length);
    params[name] = tok.type === 'number' ? tok.num : tok.value;
    n += 1;
  }

  if (n === 0) {
    return undefined;
  }

  return { text: out + text.slice(cursor), params };
};
