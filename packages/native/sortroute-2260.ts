/**
 * ⚠️⚠️ **DOES THE SORTED HOP REACH A RUNG AT ALL? (item 2260)** Item 2259 measured a sorted hop at 344
 * ns/row where an unsorted hop is 23 and a sorted SCAN is 87 — leaving **~230 ns/row explained by neither
 * term**. 🔑 [[rung-precedence-decides-speed]]'s rule is that **timing cannot distinguish "declined" from
 * "more work"**, so the route has to be read, not inferred.
 *
 * The reader is `gql-cliff-finder.ts`'s, which is `deferred-hop-order.test.ts`' `routes` helper:
 * `compileLinear` returns a record of ~22 NAMED rung fields, and the non-null ones are the rungs that fire.
 *
 * ⚠️ Its own warning matters here: **a willing rung can be STARVED by a broader one above it in
 * `runLinear`'s chain** (1.80-6.00x at item 1583), so the fired-rung SET — not just "is any rung non-null"
 * — is what must be compared across the arms.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point, read pre-build
import { parse } from '../gql/src/parser.ts';

const SHAPES: Array<[string, string]> = [
  ['project (23 ns/row)', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'],
  ['project+order (344)', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n'],
  ['project+order k (197)', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.k AS n ORDER BY n'],
  ['scan+order (87)', 'MATCH (a:Person) RETURN a.name AS n ORDER BY n'],
  ['scan (control)', 'MATCH (a:Person) RETURN a.name AS n'],
  ['project+order+limit', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n LIMIT 10'],
];

/** The rungs that fire for `src`, by NAME. ⚠️ A `boolean` field is not a rung (item 1510 broke 13 tests). */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'boolean')
    .map(([k]) => k)
    .sort();
};

const seen = new Map<string, string[]>();

for (const [label, src] of SHAPES) {
  const r = routes(src);

  seen.set(label, r);
  console.log(`  ${label.padEnd(23)} ${r.length === 0 ? 'PIPELINE (no rung)' : r.join(', ')}`);
}

/* The comparison that answers item 2259: what does adding ORDER BY REMOVE from the fired set? */
const a = new Set(seen.get('project (23 ns/row)') ?? []);
const b = new Set(seen.get('project+order (344)') ?? []);

console.log(`\n  ORDER BY REMOVES: ${[...a].filter((x) => !b.has(x)).join(', ') || '(nothing)'}`);
console.log(`  ORDER BY ADDS   : ${[...b].filter((x) => !a.has(x)).join(', ') || '(nothing)'}`);
