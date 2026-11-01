// INDEX NEVER HURTS: an invariant probe (item 1324).
//
//   bun index-never-hurts-probe.ts <arm>      # ONE ARM PER PROCESS
//   bun index-never-hurts-probe.ts            # lists the arms
//
// WHY THIS EXISTS. Item 1322 found a shape where adding an index made a Gremlin query 5.78x
// SLOWER: `seedRest` had no seek-vs-scan gate, so it took an unselective seek that cost more than
// the scan it replaced. That was found by accident, through a cross-surface comparison. The
// invariant it violated is checkable directly and systematically:
//
//     for any query Q and any index I, time(Q with I) <= time(Q without I) * tolerance
//
// A violation is a BUG of a specific kind — a planner choosing a route because an index exists
// rather than because it is cheaper — and it is invisible to every answer test, since both routes
// return the same rows.
//
// Each arm runs ONE shape in ONE process on a FRESH graph, because three separate readings in
// this run were inverted by warming: rounds inside one process (item 1320), a shared-process
// sweep (item 1321) and a memoizing adjacency field (item 1323). The caller runs each arm twice,
// `plain` and `indexed`, and compares.
//
// FIRST FULL RUN (item 1324, after item 1322's gate): 17 shapes, every answer SAME, and the
// invariant HOLDS on all of them — so item 1322 fixed the CLASS, not just the shape it was found
// on. Two shapes flagged above 1.2x on a single reading and BOTH evaporated on repeat
// (`unsel-values.grm` 1.52x -> 1.03x, `edge-count.grm` 1.35x -> 1.08x), with fully overlapping
// ranges. Treat one reading here as a hypothesis, never a violation.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  E,
  V,
  count,
  dedupe,
  has,
  hasLabel,
  order,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';
import { gt } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

const N = Number(process.env.PROBE_N ?? 100_000);
const REPS = Number(process.env.PROBE_REPS ?? 40);
const DROP = Number(process.env.PROBE_DROP ?? 20);

/**
 * `age` is `i % 90`, so `= 42` keeps ~1.1% (a seek worth taking) and `> 45` keeps ~49% (one that
 * is not). `tag` has 7 values, ~14% each — just over the 1/8 line, which is where a gate's
 * boundary lives and therefore where an off-by-one in it would show.
 */
const build = (indexed: boolean): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { age: i % 90, tag: `t${i % 7}`, n: i },
    }),
  );

  for (let i = 0; i + 1 < N; i++) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[i + 1],
      labels: ['E'],
      properties: { w: i % 90 },
    });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });
  }

  return g;
};

type Shape = { gql?: string; grm?: (g: Graph) => Plan };

/**
 * Both surfaces, because item 1322's bug was in ONE of them and the other proved a faster path
 * existed. A shape present in both also cross-checks the pair for free.
 */
const SHAPES: Record<string, Shape> = {
  // SELECTIVE — the index should WIN big here. These are the controls: a gate that over-declines
  // shows up as these losing their advantage, which is a worse bug than the one being hunted.
  'sel-count.gql': { gql: 'MATCH (n:P) WHERE n.age = 42 RETURN count(*) AS c' },
  'sel-count.grm': { grm: () => traversal(V(), hasLabel('P'), has('age', 42), count()) },
  'sel-values.gql': { gql: 'MATCH (n:P) WHERE n.age = 42 RETURN n.n AS v' },
  'sel-values.grm': { grm: () => traversal(V(), hasLabel('P'), has('age', 42), values('n')) },

  // UNSELECTIVE — ~49%, where item 1322's pathology lived.
  'unsel-count.gql': { gql: 'MATCH (n:P) WHERE n.age > 45 RETURN count(*) AS c' },
  'unsel-count.grm': { grm: () => traversal(V(), hasLabel('P'), has('age', gt(45)), count()) },
  'unsel-values.gql': { gql: 'MATCH (n:P) WHERE n.age > 45 RETURN n.n AS v' },
  'unsel-values.grm': { grm: () => traversal(V(), hasLabel('P'), has('age', gt(45)), values('n')) },

  // THE EDGE source, where item 1322's gate is wired separately from the vertex one. The two
  // arms must ask the SAME question: the first cut paired a `r.w > 45` filter in GQL against an
  // unfiltered Gremlin hop, which is not a pair at all and would have read as a cross-surface
  // gap that does not exist.
  'edge-count.gql': { gql: 'MATCH ()-[r:E]->() WHERE r.w > 45 RETURN count(*) AS c' },
  'edge-count.grm': { grm: () => traversal(E(), hasLabel('E'), has('w', gt(45)), count()) },

  // AT THE BOUNDARY — ~14%, just over the 1/8 line, which is where an off-by-one in a gate shows.
  'boundary-count.gql': { gql: "MATCH (n:P) WHERE n.tag = 't3' RETURN count(*) AS c" },
  'boundary-count.grm': { grm: () => traversal(V(), hasLabel('P'), has('tag', 't3'), count()) },

  // SHAPES PAST A COUNT, where a different consumer might read the index ungated.
  'unsel-hop.gql': { gql: 'MATCH (n:P)-[:E]->(m) WHERE n.age > 45 RETURN count(*) AS c' },
  'unsel-hop.grm': {
    grm: () => traversal(V(), hasLabel('P'), has('age', gt(45)), out('E'), count()),
  },
  'unsel-dedupe.grm': {
    grm: () => traversal(V(), hasLabel('P'), has('age', gt(45)), dedupe(), count()),
  },
  'unsel-order.grm': {
    grm: () => traversal(V(), hasLabel('P'), has('age', gt(45)), values('n'), order()),
  },
  'unsel-order.gql': { gql: 'MATCH (n:P) WHERE n.age > 45 RETURN n.n AS v ORDER BY v' },
};

const arm = process.argv[2] ?? '';
const mode = process.argv[3] ?? 'plain';
const shape = SHAPES[arm];

if (shape === undefined) {
  console.log(Object.keys(SHAPES).join('\n'));
  process.exit(2);
}

const g = build(mode === 'indexed');
const run = (): unknown => {
  if (shape.gql !== undefined) {
    const rows = query(g, shape.gql);

    return rows.length === 1 ? rows[0]?.c : rows.length;
  }

  const out_ = toArray((shape.grm as (x: Graph) => Plan)(g), g);

  return Array.isArray(out_) ? `${out_.length}:${String(out_[0])}` : out_;
};

const series: number[] = [];
let answer: unknown;

for (let i = 0; i < REPS; i++) {
  const t = performance.now();

  answer = run();
  series.push(performance.now() - t);
}

const warm = series.slice(DROP).sort((a, b) => a - b);
const med = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(`${arm}\t${mode}\t${med.toFixed(5)}\t${String(answer)}`);
