// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { compileLinear } from '../../packages/gql/src/executor/rewrites.ts';
/**
 * **IS `WHERE true` FOLDED AWAY, OR DOES IT STILL CHANGE THE ROUTE? (item 2287)**
 *
 * Item 2286 measured a vacuous predicate at **1.75 ms against 0.01** for the SAME ANSWER — 175x. Items
 * 2128/2129 priced the real-filter version of this at 20x and did NOT build it, and their blocker is
 * mathematical: the closed form is an O(V) identity that holds *"ONLY when the source set is every
 * vertex"*.
 *
 * **A predicate that excludes nothing does not break that identity** — the survivors ARE every vertex —
 * so the vacuous case escapes 2128's blocker. The question is whether the planner notices.
 *
 * This reads the ROUTE, not the time, because timing cannot tell "declined" from "more work". If
 * `WHERE true` lands on the same route as no predicate at all, folding already happens and there is
 * nothing here. If it lands elsewhere, the fold is missing and 2128's blocker does not cover it.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point, read pre-build
import { parse } from '../../packages/gql/src/parser.ts';

const SHAPES: [string, string][] = [
  ['hop count, no predicate', 'MATCH (p:P)-[:E]->(q:P) RETURN count(*) AS c'],
  ['hop count, WHERE true', 'MATCH (p:P)-[:E]->(q:P) WHERE true RETURN count(*) AS c'],
  ['hop count, WHERE 1=1', 'MATCH (p:P)-[:E]->(q:P) WHERE 1 = 1 RETURN count(*) AS c'],
  ['hop count, real filter', 'MATCH (p:P)-[:E]->(q:P) WHERE q.k = 1 RETURN count(*) AS c'],
  ['node count, no predicate', 'MATCH (p:P) RETURN count(*) AS c'],
  ['node count, WHERE true', 'MATCH (p:P) WHERE true RETURN count(*) AS c'],
];

const shape = (v: unknown, d = 0): string => {
  if (v === null || v === undefined) {
    return String(v);
  }

  if (typeof v === 'function') {
    return 'fn';
  }

  if (Array.isArray(v)) {
    return `[${v.length}]`;
  }

  if (typeof v === 'object' && d < 2) {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}:${shape(x, d + 1)}`)
      .join(' ')}}`;
  }

  return typeof v === 'object' ? 'obj' : JSON.stringify(v);
};

for (const [label, src] of SHAPES) {
  const [part] = (parse(src) as unknown as { parts: unknown[] }).parts;
  let route = '?';

  try {
    const plan = compileLinear(part as never) as Record<string, unknown> | undefined;

    /*
     * **PRINT THE VALUE, NOT ITS PRESENCE.** Every shape here reports `countShortcut` as non-null,
     * including the real filter — so field presence says nothing and the route difference is INSIDE it.
     * This is the recorded `gate-returning-a-value` rule: three wrong residuals got through by asserting
     * that a gate returned something.
     */
    route =
      plan === undefined
        ? '(declined)'
        : shape((plan as { countShortcut?: unknown }).countShortcut);
  } catch (e) {
    route = `(threw: ${(e as Error).message.slice(0, 50)})`;
  }

  console.log(`  ${label.padEnd(26)} -> ${route}`);
}
