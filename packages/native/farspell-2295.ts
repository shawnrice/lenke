// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point
import { compileLinear } from '../../packages/gql/src/executor/rewrites.ts';
/**
 * Why is the CLAUSE spelling 2.8x FASTER here, when item 2291 found the opposite? (item 2295)
 *
 * The GQL spelling probe's far-node group, isolated and reproducible to within 1%:
 *
 *     (b {k: 5})          130.7 / 128.6 / 129.1 ms   inline prop anchor
 *     (b WHERE b.k = 5)   146.7 / 143.8 / 145.6      inline WHERE
 *     (b) WHERE b.k = 5    46.3 /  46.4 /  46.1      CLAUSE — 2.8x FASTER
 *
 * Note the far node is UNLABELLED, so item 2293's bucket-ratio gate cannot fire (an unlabelled
 * bucket is every vertex, never 64x smaller than `:P`). This is a different cause, and the direction is
 * reversed from item 2291's authz shape — so reading the route is the cheap first question.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point
import { parse } from '../../packages/gql/src/parser.ts';

const SHAPES: [string, string][] = [
  ['inline prop anchor', 'MATCH (a:P)-[:E]->(b {k: 5}) RETURN b.k AS v'],
  ['inline WHERE', 'MATCH (a:P)-[:E]->(b WHERE b.k = 5) RETURN b.k AS v'],
  ['clause WHERE (FASTEST)', 'MATCH (a:P)-[:E]->(b) WHERE b.k = 5 RETURN b.k AS v'],
  /* The same three with a LABELLED far node, to see whether the label changes the route. */
  ['labelled, inline prop', 'MATCH (a:P)-[:E]->(b:P {k: 5}) RETURN b.k AS v'],
  ['labelled, clause', 'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 5 RETURN b.k AS v'],
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
