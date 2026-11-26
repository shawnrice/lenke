// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point
import { compileLinear } from '../../packages/gql/src/executor/rewrites.ts';
/**
 * Why does a START filter cost 18x PER ROW on a 1-hop projection? (item 2309)
 *
 * `bun run bench`, same fixture (`hopPairDoc`, 200,000 vertices / 1,000,000 edges):
 *
 *     traverse 1-hop project                 19.0 ms   ~1,000,000 rows    19 ns/row
 *     traverse 1-hop project + start filter 110.8 ms     ~320,000 rows   346 ns/row
 *
 * FEWER rows, 5.8x more time — 18x per row. `a.age > 60` over `age = i % 90` keeps 29/90 of the
 * starts, so the filter is selective and should REDUCE work.
 *
 * Item 1716 corrected this family once (three rows projected a property the fixture lacked, so the
 * whole "project" family measured NULLS); the current fixture carries `name`, so the comparison is
 * post-fix.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point
import { parse } from '../../packages/gql/src/parser.ts';

const SHAPES: [string, string][] = [
  ['plain projection', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'],
  ['+ start filter (cmp)', 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 60 RETURN x.name AS n'],
  ['+ start filter (eq)', 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age = 60 RETURN x.name AS n'],
  ['+ start INLINE anchor', 'MATCH (a:Person {age: 60})-[:KNOWS]->(x) RETURN x.name AS n'],
  ['+ FAR filter (cmp)', 'MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 60 RETURN x.name AS n'],
];

for (const [label, src] of SHAPES) {
  const [part] = (parse(src) as unknown as { parts: unknown[] }).parts;
  let route = '?';

  try {
    const plan = compileLinear(part as never) as Record<string, unknown> | undefined;

    route =
      plan === undefined
        ? '(declined — the GENERAL matcher answers it)'
        : Object.entries(plan)
            .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'boolean')
            .map(([k]) => k)
            .join(', ') || '(no non-null fields)';
  } catch (e) {
    route = `(threw: ${(e as Error).message.slice(0, 50)})`;
  }

  console.log(`  ${label.padEnd(24)} -> ${route}`);
}
