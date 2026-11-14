/**
 * WHAT DOES THE TWO-COLUMN `DISTINCT` KEY COST, AND WHAT IS ITS FLOOR? (item 1886)
 *
 * ⚠️ ITEM 1825 NAMED THIS ITEM AND LEFT THE FLOOR: it took multi-column `DISTINCT` at one hop from
 * 32.5 to 7.5 ms (4.4x) by handing the shape to the hop rung with a synthetic non-distinct
 * projection and deduping the result — and recorded what was left as "the multi-column keying
 * itself (`rowKeyOf` costs two array allocations, a string build and a hash per row, where the
 * one-column path has a value-keyed fast route). **A two-column fast key is its own item, with
 * 7.5 ms as the floor.**"
 *
 * `rung-gap-screen.mjs` still flags the cell: `distinct2 depth1` at **7.3 ms against its own `rows`
 * twin's 1.7** — 4.3x, and the only flag on that grid that is neither a documented byte-identity
 * refusal (`sum`, `collect`) nor noise-sized.
 *
 * ⚠️ THE ARMS ARE CHOSEN SO THE KEYING IS THE ONLY DIFFERENCE between neighbours:
 *
 *     rows        the undeduped twin — the walk alone, and the floor the key is added to
 *     distinct1   ONE column: takes `distinctRows`' value-keyed fast route
 *     distinct2   TWO columns: falls to `rowKeyOf`
 *     twocol      TWO columns, NOT deduped — isolates "a second column costs something" from
 *                 "keying two columns costs something", which a `distinct2`/`rows` ratio conflates
 *
 * ⚠️ ONE SHAPE PER PROCESS (items 1870/1874), and `SERIES=1` prints the per-rep series, which is
 * what item 1884 needed to see that a 9-rep window was measuring warm-up as the steady state.
 *
 *     for s in rows distinct1 distinct2 twocol; do SHAPE=$s bun distinct2-key-1886.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const REPS = Number(process.env.REPS ?? 20);
const SHAPE = process.env.SHAPE ?? 'distinct2';
/** How many DISTINCT pairs the fixture holds — the dedupe's output size, varied deliberately. */
const CARD = Number(process.env.CARD ?? 97);

const g = new Graph();
const verts = [];

for (let i = 0; i < N; i += 1) {
  verts.push(
    g.addVertex({
      id: `v${String(i)}`,
      labels: ['P'],
      properties: { k: i % CARD, s: `s${String(i % 7)}`, n: i },
    }),
  );
}

// One edge per vertex, a coprime stride so the endpoints are a permutation rather than the single
// collapsed target an `(a * k + b) % N` generator gives at any higher fanout (items 1516/1518).
for (let i = 0; i < N; i += 1) {
  g.addEdge({ id: `e${String(i)}`, from: verts[i], to: verts[(i * 7 + 3) % N], labels: ['E'] });
}

{
  const ends = new Set(Array.from({ length: N }, (_, i) => (i * 7 + 3) % N));

  if (ends.size !== N) {
    throw new Error(`fixture: ${String(ends.size)} distinct endpoints for ${String(N)} edges`);
  }
}

const SHAPES = {
  rows: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k',
  distinct1: 'MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.k AS k',
  distinct2: 'MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.k AS k, b.s AS s',
  twocol: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k, b.s AS s',
  // The other two callers of the same key space (added at item 1886 alongside `distinctRows`):
  // `distinctUnion` and `twoColumnSetOp`. Item 1561 measured the ONE-column versions at 4.01x and
  // 1.25x, so these are the two-column twins of that work.
  union2: 'MATCH (n:P) RETURN n.k AS k, n.s AS s UNION MATCH (n:P) RETURN n.n AS k, n.s AS s',
  except2:
    'MATCH (n:P) RETURN n.k AS k, n.s AS s EXCEPT MATCH (n:P) WHERE n.n < 5000 RETURN n.k AS k, n.s AS s',
  intersect2:
    'MATCH (n:P) RETURN n.k AS k, n.s AS s INTERSECT MATCH (n:P) WHERE n.n < 5000 RETURN n.k AS k, n.s AS s',
};

const text = SHAPES[SHAPE];
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 3; r += 1) {
  const t0 = performance.now();

  rows = query(g, text).length;

  const ms = performance.now() - t0;

  // THREE warm-up reps dropped, not two: CLAUDE.md's recipe for the TS per-row path, where the
  // first reps are visibly the JIT tiering up.
  if (r >= 3) {
    series.push(ms);
  }
}

if (process.env.SERIES === '1') {
  console.log(`# ${SHAPE} series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
}

const sorted = [...series].sort((a, b) => a - b);
const ms = sorted[sorted.length >> 1];

console.log(
  `${SHAPE.padEnd(10)} ${ms.toFixed(2).padStart(8)} ms  ${String(rows).padStart(7)} rows out  ` +
    `${((ms * 1e6) / N).toFixed(0).padStart(5)} ns per INPUT row   (N=${String(N)}, card=${String(CARD)})`,
);
