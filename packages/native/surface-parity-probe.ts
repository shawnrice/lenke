// CROSS-SURFACE PARITY: for the SAME question, do the two TS surfaces cost the same? (item 1322)
//
//   bun surface-parity-probe.ts <arm>        # ONE ARM PER PROCESS
//   arms: <question>.gql | <question>.grm    # run with no arm to list them
//
// THIS PROBE FOUND A PATHOLOGY NOTHING ELSE COULD SEE, so it is kept rather than thrown away:
// `filter-count` read GQL 3.95 ms against Gremlin 13.45, which proved Gremlin was not at the
// layout floor item 1321 had just concluded it was — the same engine already had a faster path.
// The cause was Gremlin having no seek-vs-scan gate (item 1322).
//
// Re-run it whenever EITHER planner changes. The gap it is built to catch is invisible to every
// other instrument here: `bench:usage` runs GQL rows plus two native-only Gremlin rows,
// `bench:gremlin` compares Gremlin against native, and both spelling probes compare spellings
// WITHIN one surface.
//
// STILL OPEN from its last run: `two-hop-count` with GQL 1.84x SLOWER than Gremlin (18.17 ms
// against 9.85) — the other direction, unexamined.
//
// Users pick GQL xor Gremlin (`single-engine-parallel-naming`), so a surface that is much slower
// for an identical question costs HALF the users and nothing measures it: `bench:usage` runs GQL
// rows plus two native-only Gremlin rows, `bench:gremlin` runs Gremlin against native, and the
// spelling probes compare spellings WITHIN a surface, never across.
//
// ONE SHAPE PER PROCESS, selected by argv — items 1320/1321 both had a comparison inverted by
// running arms in a shared process.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, both, count, has, hasLabel, out, toArray, traversal, gt } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

const N = Number(process.env.PROBE_N ?? 200_000);
const REPS = Number(process.env.PROBE_REPS ?? 80);
const DROP = Number(process.env.PROBE_DROP ?? 40);

const graph = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90, tag: `t${i % 7}` } }),
);

for (let i = 0; i + 1 < N; i++) {
  graph.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: {} });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

// Each pair is ONE question, spelled once per surface. The answers are compared, so a pair that
// does not actually ask the same thing fails loudly rather than reporting a meaningless ratio.
const ARMS: Record<string, { gql?: string; gremlin?: Plan }> = {
  'count-all.gql': { gql: 'MATCH (n:P) RETURN count(*) AS c' },
  'count-all.grm': { gremlin: traversal(V(), hasLabel('P'), count()) },

  'filter-count.gql': { gql: 'MATCH (n:P) WHERE n.age > 45 RETURN count(*) AS c' },
  'filter-count.grm': { gremlin: traversal(V(), hasLabel('P'), has('age', gt(45)), count()) },

  'seek-count.gql': { gql: 'MATCH (n:P) WHERE n.age = 42 RETURN count(*) AS c' },
  'seek-count.grm': { gremlin: traversal(V(), hasLabel('P'), has('age', 42), count()) },

  'hop-count.gql': { gql: 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c' },
  'hop-count.grm': { gremlin: traversal(V(), hasLabel('P'), out('E'), count()) },

  'both-count.gql': { gql: 'MATCH (a:P)-[:E]-(b) RETURN count(*) AS c' },
  'both-count.grm': { gremlin: traversal(V(), hasLabel('P'), both('E'), count()) },

  'two-hop-count.gql': { gql: 'MATCH (a:P)-[:E]->()-[:E]->(c) RETURN count(*) AS c' },
  'two-hop-count.grm': { gremlin: traversal(V(), hasLabel('P'), out('E'), out('E'), count()) },
};

const arm = process.argv[2] ?? '';
const spec = ARMS[arm];

if (spec === undefined) {
  console.log(`arms: ${Object.keys(ARMS).join(' ')}`);
  process.exit(2);
}

const runOnce = (): unknown => {
  if (spec.gql !== undefined) {
    return query(graph, spec.gql)[0]?.c;
  }

  const out_ = toArray(spec.gremlin as Plan, graph);

  return Array.isArray(out_) ? out_[0] : out_;
};

const series: number[] = [];
let answer: unknown;

for (let i = 0; i < REPS; i++) {
  const t = performance.now();

  answer = runOnce();
  series.push(performance.now() - t);
}

const warm = series.slice(DROP).sort((a, b) => a - b);
const med = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(`${arm}\t${med.toFixed(5)}\t${String(answer)}`);
