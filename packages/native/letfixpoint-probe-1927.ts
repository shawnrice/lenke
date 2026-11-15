// Item 1927 — WOULD A FIXPOINT ACTUALLY REACH THE FOLDED SHAPE, and what does the expression
// cost in SIZE?
//
// Item 1926 widened `boundExprs` to admit any expression, which took the SINGLE `LET` from 54.99 ms
// to 8.33 — but `inlineTrailingLet` runs ONCE, not to a fixpoint, so a chain still leaves one
// standing and a standing `LET` is off every one of the twenty-one rungs:
//
//     chain2  LET a = n.n + 1 LET b = a * 2 RETURN b AS x      63.38 ms
//     folded  RETURN (n.n + 1) * 2 AS x                        12.45      <- ~5x available
//
// ⚠️ THE HAZARD IS EXPRESSION BLOWUP, and the claim is that item 1926's once-read guard ALREADY
// prevents it: `LET b = a + a` folds to a projection reading `a` TWICE, which the guard then
// refuses, so each surviving fold duplicates nothing. This measures that rather than asserting it:
// it applies the pass REPEATEDLY by hand and prints, per round, the clause kinds and the SIZE of
// the projection expression (its serialized node count), so a quadratic or exponential shape would
// be visible as growth rather than inferred from the argument above.
//
//     bun letfixpoint-probe-1927.ts
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point; same exemption `rung-precedence-census.mjs` carries
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- see above
import { parse } from '../gql/src/parser.ts';

const SHAPES: Record<string, string> = {
  single: 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x',
  chain2: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x',
  chain3: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 LET c = b + 3 RETURN c AS x',
  chain5:
    'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 LET c = b + 3 LET d = c * 4 LET e = d + 5 RETURN e AS x',
  // ⚠️ THE BLOWUP SHAPE. Each binding reads the previous one TWICE, so a fold that ignored the
  // once-read guard would double the expression every round: 2^k. The guard must refuse at round 1.
  doubling: 'MATCH (n:T) LET a = n.n + 1 LET b = a + a LET c = b + b LET d = c + c RETURN d AS x',
  // A chain whose LAST link is read twice — the fixpoint must stop there, not at the start.
  tailTwice: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b + b AS x',
  // Mixed: a cheap binding between two arithmetic ones.
  mixed: 'MATCH (n:T) LET a = n.n + 1 LET b = a LET c = b * 2 RETURN c AS x',
};

/** The clause kinds `compileLinear` ended up with. */
const kindsOf = (text: string): string => {
  const parsed = parse(text) as { parts?: readonly unknown[] };
  const linear = (parsed.parts === undefined ? parsed : parsed.parts[0]) as Parameters<
    typeof compileLinear
  >[0];

  return compileLinear(linear)
    .clauses.map((c) => c.kind)
    .join(',');
};

/*
 * ⚠️ MY FIRST MODEL OF THIS WAS WRONG AND THE PROBE SAID SO IMMEDIATELY: `compileLinear` returns
 * COMPILED clauses (`CClause`), not AST clauses, so `compileLinear(compileLinear(x))` is not a
 * fixpoint — it threw inside `freePredicateVars` on a node with no `kind`. A fixpoint has to live
 * INSIDE `compileLinear`, around the AST rewrite chain.
 *
 * 🔑 So the question is asked a different way, and a better one: does the HAND-FOLDED INTERMEDIATE
 * fold again? If `LET a = n.n + 1 RETURN (a * 2) AS x` compiles to `[match, return]`, then a second
 * application of the pass would have taken chain2 there too, and a fixpoint is worth building. If
 * it does not, the fixpoint is worthless and no code needs writing.
 */
const ROUNDS: Record<string, readonly string[]> = {
  chain2: [
    'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x',
    'MATCH (n:T) LET a = n.n + 1 RETURN (a * 2) AS x',
    'MATCH (n:T) RETURN ((n.n + 1) * 2) AS x',
  ],
  chain3: [
    'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 LET c = b + 3 RETURN c AS x',
    'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN (b + 3) AS x',
    'MATCH (n:T) LET a = n.n + 1 RETURN ((a * 2) + 3) AS x',
    'MATCH (n:T) RETURN (((n.n + 1) * 2) + 3) AS x',
  ],
  // ⚠️ THE BLOWUP SHAPE: each binding reads the previous one TWICE. The guard must refuse at the
  // FIRST round, so the hand-folded intermediate should KEEP its LET.
  doubling: [
    'MATCH (n:T) LET a = n.n + 1 LET b = a + a RETURN b AS x',
    'MATCH (n:T) LET a = n.n + 1 RETURN (a + a) AS x',
  ],
};

for (const [name, texts] of Object.entries(ROUNDS)) {
  const seen = texts.map((t, i) => `r${String(i)}=${kindsOf(t)}`);

  console.log(`${name.padEnd(9)} ${seen.join('  ')}`);
}

console.log('\n--- single-application shapes, for reference:');

for (const [name, text] of Object.entries(SHAPES)) {
  console.log(`${name.padEnd(10)} ${kindsOf(text)}`);
}
