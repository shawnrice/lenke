// Item 1927 — HOW MANY NATURAL SPELLINGS DOES `subst`'s ONE-LEVEL RESTRICTION STRAND?
//
// Item 1926 widened `boundExprs` so `LET a = n.n + 1 RETURN a AS x` folds (54.99 -> 8.33 ms). But
// `letfixpoint-probe-1927.ts` then refuted the obvious follow-up: a FIXPOINT would do nothing,
// because the hand-folded intermediate `LET a = n.n + 1 RETURN (a * 2) AS x` STILL keeps its `LET`.
// `subst` substitutes a bound name only where it is the WHOLE expression or a function's bare
// ARGUMENT, so a name nested one level inside arithmetic is refused.
//
// ⚠️ THE QUESTION IS BREADTH, NOT THE CHAIN. The chain row is one shape; if the one-level
// restriction also strands `RETURN a * 2`, `RETURN a > 5`, `ORDER BY a * 2` and so on, this is a
// family rather than a case — and that is what decides whether a deep substitution is worth its
// safety argument. Each row prints the clause kinds, so a standing `let` is the finding.
//
//     bun letdeep-breadth-1927.ts
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point; same exemption `rung-precedence-census.mjs` carries
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- see above
import { parse } from '../gql/src/parser.ts';

const kindsOf = (text: string): string => {
  try {
    const parsed = parse(text) as { parts?: readonly unknown[] };
    const linear = (parsed.parts === undefined ? parsed : parsed.parts[0]) as Parameters<
      typeof compileLinear
    >[0];

    return compileLinear(linear)
      .clauses.map((c) => c.kind)
      .join(',');
  } catch (err) {
    return `THREW: ${String((err as Error).message).slice(0, 48)}`;
  }
};

/** `[label, the LET spelling, the hand-written equivalent that needs no LET]` */
const PAIRS: readonly (readonly [string, string, string])[] = [
  // ——— the shapes item 1926 already folds, as the CONTROL that this probe can see a fold ———
  [
    'bare name (1926)',
    'MATCH (n:T) LET a = n.n + 1 RETURN a AS x',
    'MATCH (n:T) RETURN (n.n + 1) AS x',
  ],
  [
    'function arg (565)',
    'MATCH (n:T) LET a = n.n + 1 RETURN abs(a) AS x',
    'MATCH (n:T) RETURN abs(n.n + 1) AS x',
  ],
  // ——— nested ONE level inside an operator: the stranded family ———
  ['arith wrap', 'MATCH (n:T) LET a = n.n RETURN a * 2 AS x', 'MATCH (n:T) RETURN n.n * 2 AS x'],
  [
    'arith wrap, computed bind',
    'MATCH (n:T) LET a = n.n + 1 RETURN a * 2 AS x',
    'MATCH (n:T) RETURN (n.n + 1) * 2 AS x',
  ],
  [
    'comparison wrap',
    'MATCH (n:T) LET a = n.n RETURN a > 5 AS x',
    'MATCH (n:T) RETURN n.n > 5 AS x',
  ],
  [
    'func arg nested',
    'MATCH (n:T) LET a = n.n RETURN abs(a + 1) AS x',
    'MATCH (n:T) RETURN abs(n.n + 1) AS x',
  ],
  [
    'aggregate over an expr (the comment own example)',
    'MATCH (n:T) LET c = n.n RETURN sum(c + 1) AS x',
    'MATCH (n:T) RETURN sum(n.n + 1) AS x',
  ],
  [
    'CASE over the name',
    'MATCH (n:T) LET a = n.n RETURN CASE WHEN a > 5 THEN 1 ELSE 0 END AS x',
    'MATCH (n:T) RETURN CASE WHEN n.n > 5 THEN 1 ELSE 0 END AS x',
  ],
  [
    'ORDER BY wraps the name',
    'MATCH (n:T) LET a = n.n RETURN n.k AS x ORDER BY a * 2',
    'MATCH (n:T) RETURN n.k AS x ORDER BY n.n * 2',
  ],
  [
    'string fn nested',
    'MATCH (n:T) LET s = n.s RETURN upper(trim(s)) AS x',
    'MATCH (n:T) RETURN upper(trim(n.s)) AS x',
  ],
  [
    'list element',
    'MATCH (n:T) LET a = n.n RETURN [a, 1] AS x',
    'MATCH (n:T) RETURN [n.n, 1] AS x',
  ],
  ['map field', 'MATCH (n:T) LET a = n.n RETURN {v: a} AS x', 'MATCH (n:T) RETURN {v: n.n} AS x'],
  // ——— the hop shape, the most common in the language ———
  [
    'HOP arith wrap',
    'MATCH (a:T)-[:E]->(b:T) LET v = b.n RETURN v * 2 AS x',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n * 2 AS x',
  ],
  // ——— and the shapes that MUST keep standing, whatever is built ———
  [
    'REFUSE read twice',
    'MATCH (n:T) LET a = n.n + 1 RETURN a + a AS x',
    'MATCH (n:T) RETURN (n.n + 1) + (n.n + 1) AS x',
  ],
  [
    'REFUSE read zero times',
    'MATCH (n:T) LET a = n.n + 1 RETURN n.k AS x',
    'MATCH (n:T) RETURN n.k AS x',
  ],
];

let stranded = 0;

for (const [label, letForm, handForm] of PAIRS) {
  const a = kindsOf(letForm);
  const b = kindsOf(handForm);
  const gap = a !== b;

  if (gap && !label.startsWith('REFUSE')) {
    stranded += 1;
  }

  let mark = gap ? '⬅ STRANDED' : 'folds';

  if (label.startsWith('REFUSE')) {
    mark = gap ? 'ok (stands)' : '⚠️ FOLDED';
  }

  console.log(`${label.padEnd(44)} let=[${a.padEnd(22)}] hand=[${b.padEnd(14)}]  ${mark}`);
}

console.log(
  `\n${String(stranded)} of ${String(PAIRS.length)} spellings stranded by the one-level restriction`,
);
