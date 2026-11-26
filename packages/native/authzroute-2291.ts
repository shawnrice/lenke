// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point
import { compileLinear } from '../../packages/gql/src/executor/rewrites.ts';
/**
 * Which rung takes the authz list, and does an index change it? (item 2291)
 *
 * `hop2-projection.ts`'s `shouldDeclineToOrientedMatcher` hands a query to the orienting matcher only
 * when `farEndSeeksNarrower`. A hash index on the far node's key is PROVEN to work here (a 400,000-user
 * name lookup goes 7.01 ms → 0.00) and the orientation still does not change — so either this query is not
 * on that rung at all, or the gate is not reading what I think.
 *
 * Timing cannot tell those apart, so this reads the route.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point
import { parse } from '../../packages/gql/src/parser.ts';

const SHAPES: [string, string][] = [
  [
    'authz subject-first',
    'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $doc RETURN u.name AS n',
  ],
  [
    'authz object-first',
    'MATCH (d:Doc)<-[:CAN_VIEW]-(t:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $doc RETURN u.name AS n',
  ],
  [
    'authz two MATCH clauses',
    'MATCH (t:Team)-[:CAN_VIEW]->(d:Doc) MATCH (u:User)-[:MEMBER_OF]->(t) WHERE d.name = $doc RETURN u.name AS n',
  ],
  ['one hop, far predicate', 'MATCH (a:A)-[:E]->(b:B) WHERE b.k = $x RETURN a.n AS n'],
];

for (const [label, src] of SHAPES) {
  const [part] = (parse(src) as unknown as { parts: unknown[] }).parts;
  let route = '?';

  try {
    const plan = compileLinear(part as never) as Record<string, unknown> | undefined;

    route =
      plan === undefined
        ? '(declined — no linear plan; the GENERAL matcher answers it)'
        : Object.entries(plan)
            .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'boolean')
            .map(([k]) => k)
            .join(', ') || '(no non-null fields)';
  } catch (e) {
    route = `(threw: ${(e as Error).message.slice(0, 50)})`;
  }

  console.log(`  ${label.padEnd(26)} -> ${route}`);
}
