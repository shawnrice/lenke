/**
 * WHICH RUNGS ARE WILLING for the four modifiers item 2414 flagged at DEPTH 1, against the same
 * modifier at depth 2 and against the `rows` cell they are each compared with.
 *
 * This is the FIRST question and not a profile: item 2414's flag is a RATIO (each modifier ~3x its
 * own `rows` cell at one hop while the same modifier at 2+ hops sits at or below it), and a ratio
 * has two readings. Either the modifier declines a one-hop rung that `rows` takes - a route gap,
 * which is the thing the screen was built to find - or the one-hop `rows` cell is simply served by
 * something no aggregate can reach, and the modifiers are at their own floor.
 *
 * A route list cannot tell a DECLINE from MORE WORK (that is `rung-precedence-decides-speed`), so
 * this narrows rather than answers: a modifier with NO willing rung at depth 1 while `rows` has one
 * is a candidate; a modifier already on a rung is a profile question instead.
 */
import { Graph } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: a SOURCE import that avoids the build step, which is the whole point. This probe ablates hop-projection.ts by patching src; through `@lenke/gql` it would read dist and the patch would be invisible ([[fuzzers-read-built-dists]]).
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: a SOURCE import that avoids the build step, which is the whole point. This probe ablates hop-projection.ts by patching src; through `@lenke/gql` it would read dist and the patch would be invisible ([[fuzzers-read-built-dists]]).
import { parse } from '../gql/src/parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const chain = (depth: number): { text: string; far: string } => {
  let text = 'MATCH (a:P)';
  let far = 'a';

  for (let d = 1; d <= depth; d += 1) {
    far = `x${String(d)}`;
    text += `-[:E]->(${far}:P)`;
  }

  return { text, far };
};

const MODIFIERS: Record<string, (c: { text: string; far: string }) => string> = {
  rows: ({ text, far }) => `${text} RETURN ${far}.k AS k`,
  topk: ({ text, far }) => `${text} RETURN ${far}.k AS k ORDER BY k LIMIT 10`,
  skiponly: ({ text, far }) => `${text} RETURN ${far}.k AS k SKIP 5`,
  grouped: ({ text, far }) => `${text} RETURN ${far}.k AS k, count(*) AS c`,
  collect: ({ text, far }) => `${text} RETURN collect(${far}.k) AS ks`,
  // CONTROLS: `count(*)` is the cheapest aggregate and `orderby` is `topk` without the LIMIT, so
  // the two bracket what a one-hop projection pays for sorting versus for aggregating at all.
  count: ({ text }) => `${text} RETURN count(*) AS c`,
  orderby: ({ text, far }) => `${text} RETURN ${far}.k AS k ORDER BY k`,
  sum: ({ text, far }) => `${text} RETURN sum(${far}.k) AS s`,
  maxagg: ({ text, far }) => `${text} RETURN max(${far}.k) AS m`,
  distinct: ({ text, far }) => `${text} RETURN DISTINCT ${far}.k AS k`,
  countk: ({ text, far }) => `${text} RETURN count(${far}.k) AS c`,
  distinct2: ({ text, far }) => `${text} RETURN DISTINCT ${far}.k AS k, ${far}.s AS s`,
  q11: ({ text }) => `${text.replace('-[:E]->', '-[:E]->{1,1}')} RETURN DISTINCT x1.k AS k`,
  minagg: ({ text, far }) => `${text} RETURN min(${far}.k) AS m`,
  avgagg: ({ text, far }) => `${text} RETURN avg(${far}.k) AS a`,
  nearsum: ({ text }) => `${text} RETURN sum(a.k) AS s`,
  pct: ({ text, far }) => `${text} RETURN percentile_cont(${far}.k, 0.5) AS p`,
  countdist: ({ text, far }) => `${text} RETURN count(DISTINCT ${far}.k) AS c`,
};

// Touch Graph so the probe builds the same module graph a real run does.
void new Graph();

for (const depth of [1, 2]) {
  const c = chain(depth);

  console.log(`\n# depth ${String(depth)}  ${c.text}`);

  for (const [name, make] of Object.entries(MODIFIERS)) {
    const src = make(c);

    console.log(`  ${name.padEnd(10)} ${JSON.stringify(routes(src))}`);
  }
}
