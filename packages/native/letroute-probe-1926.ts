// Item 1926 — WHICH RUNG DOES A `LET` SHAPE REACH, if any?
//
// ⚠️ TIMING CANNOT TELL "DECLINED" FROM "MORE WORK" ([[rung-precedence-decides-speed]]): the fix is
// to read `compileLinear`'s non-null fields. `MATCH (n:T) LET a = n.n + 1 RETURN a AS x` measures
// **54.99 ms against the hand-folded `RETURN (n.n + 1) AS x`'s 9.26** — 5.9x — and
// `inlineTrailingLet` is supposed to turn the first into the second. So either the rewrite is not
// firing, or it fires and the result still reaches no rung.
//
// This prints, for each shape: the CLAUSE KINDS the planner ended up with (so a surviving `LET` is
// visible) and every rung field that is set.
//
//     bun letroute-probe-1926.mjs
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point; same exemption `rung-precedence-census.mjs` carries, and for the same reason: `compileLinear` has no public export and widening the barrel for a probe would be the wrong trade.
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- see above
import { parse } from '../gql/src/parser.ts';

const SHAPES = {
  plain: 'MATCH (n:T) RETURN n.n AS x',
  folded: 'MATCH (n:T) RETURN (n.n + 1) * 2 AS x',
  single: 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x',
  chain2: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x',
  chain3: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 LET c = b + 3 RETURN c AS x',
  // A LET whose name is read TWICE, which the one-level fold still substitutes.
  twice: 'MATCH (n:T) LET a = n.n + 1 RETURN a + a AS x',
  // A hop shape, to see whether the LET penalty is node-specific.
  hopPlain: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
  hopLet: 'MATCH (a:T)-[:E]->(b:T) LET v = b.n + 1 RETURN v AS x',
};

const RUNGS = [
  'chainFoldedAggregate',
  'chainGroupedCount',
  'chainOrderedProjection',
  'chainProjection',
  'countShortcut',
  'forCount',
  'forProjection',
  'groupCountShortcut',
  'groupHopShortcut',
  'hop2FoldedAggregate',
  'hop2GroupedCount',
  'hop2OrderedProjection',
  'hop2Projection',
  'hopDistinctProjection',
  'hopProjection',
  'nodeDistinctProjection',
  'optionalHopCount',
  'optionalHopProjection',
  'optionalOrderedProjection',
  'reachShortcut',
  'varLengthCount',
];

for (const [name, text] of Object.entries(SHAPES)) {
  let verdict;

  try {
    // The planner's internal types are not exported as a public surface, so this probe reads
    // them structurally rather than widening the barrel for a diagnostic.
    const q = parse(text) as { parts?: readonly unknown[] };
    const linear = (q.parts === undefined ? q : q.parts[0]) as Parameters<typeof compileLinear>[0];
    const c = compileLinear(linear) as unknown as Record<string, unknown> & {
      clauses: readonly { kind: string }[];
    };
    const kinds = c.clauses.map((cl) => cl.kind).join(',');
    const set = RUNGS.filter((r) => c[r] !== undefined && c[r] !== null);

    // ⚠️ THE PROJECTION'S EXPRESSION KIND, because `inlineTrailingLet`'s first substitution branch
    // keys on `e.kind === 'var'` — if an aliased `RETURN a AS x` does not present as a bare var,
    // that branch never fires and the whole diagnosis changes.
    const { clauses } = linear as unknown as {
      clauses?: readonly {
        projection?: { items?: readonly { expr?: { kind?: string }; alias?: string }[] };
      }[];
    };
    const retClause = clauses?.[clauses.length - 1];
    const projKinds = (retClause?.projection?.items ?? [])
      .map((it) => `${it.expr?.kind}${it.alias === undefined ? '' : '/as'}`)
      .join(',');

    verdict =
      `clauses=[${kinds}]  rungs=${set.length > 0 ? set.join(' ') : 'NONE'}` +
      `  parsedProj=[${projKinds}]`;
  } catch (e) {
    verdict = `THREW ${String(e).slice(0, 70)}`;
  }

  console.log(`${name.padEnd(9)} ${verdict}`);
}

console.log(
  '\n⚠️ A surviving `let` in the clause list means `inlineTrailingLet` did not fold it. `rungs=NONE`\n' +
    '   means the shape reaches the general per-clause path whatever its timing looks like.',
);
