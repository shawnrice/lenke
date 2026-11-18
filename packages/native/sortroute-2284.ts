// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { compileLinear } from '../../packages/gql/src/executor/rewrites.ts';
/**
 * ⚠️⚠️ **WHICH RUNG CLAIMS `ORDER BY … LIMIT k`, AND WHY DOESN'T IT REACH `topKPlan`? (item 2284)**
 *
 * 🔑 The decomposition is unambiguous: `LIMIT 100` costs 2.42 ms against 2.41 for sorting all 60,000 rows,
 * so the top-K heap built at item 1064 is not engaging. The sort is 52% of that row, so a working heap is
 * worth ~2.1x.
 *
 * ⚠️ **Timing cannot tell "declined" from "more work"** — my own recorded rule — so this reads the route
 * directly off `compileLinear`, printing which fields are non-null for each spelling. `topKPlan` lives on
 * the node-scan rung, so if a broader projection rung claims these shapes first, that is
 * `rung-precedence-decides-speed`: a willing fast rung starved by one above it.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point, read pre-build
import { parse } from '../../packages/gql/src/parser.ts';

const SHAPES: [string, string][] = [
  ['bare scan', 'MATCH (p:Person) RETURN p.name AS n'],
  ['order, no limit', 'MATCH (p:Person) RETURN p.name AS n ORDER BY n'],
  ['order + LIMIT 100', 'MATCH (p:Person) RETURN p.name AS n ORDER BY n LIMIT 100'],
  ['order + LIMIT, prop key', 'MATCH (p:Person) RETURN p.name AS n ORDER BY p.name LIMIT 100'],
  ['order + LIMIT, no alias', 'MATCH (p:Person) RETURN p.name ORDER BY p.name LIMIT 100'],
  ['order + LIMIT, element', 'MATCH (p:Person) RETURN p AS p ORDER BY p.name LIMIT 100'],
  [
    'order + LIMIT 100, where',
    'MATCH (p:Person) WHERE p.seniority >= 2 RETURN p.name AS n ORDER BY n LIMIT 100',
  ],
];

for (const [label, src] of SHAPES) {
  const [part] = (parse(src) as unknown as { parts: unknown[] }).parts;
  let route = '(compileLinear returned nothing)';

  try {
    const plan = compileLinear(part as never) as Record<string, unknown> | undefined;

    route =
      plan === undefined
        ? '(declined — no linear plan)'
        : Object.entries(plan)
            .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'boolean')
            .map(([k]) => k)
            .join(', ') || '(no non-null fields)';
  } catch (e) {
    route = `(threw: ${(e as Error).message.slice(0, 60)})`;
  }

  console.log(`  ${label.padEnd(26)} -> ${route}`);
}
