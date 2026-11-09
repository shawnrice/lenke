/**
 * `spelling-probe.ts`'s EXACT FIXTURE, three queries, ONE PER PROCESS (item 1702).
 *
 * `bun run spelling` flags `three hops, THIRD position filtered (item 222)` at 29.18x / 31.18x /
 * 29.33x across three isolated runs, same answer: a clause `WHERE c.k = 2` at 334-371 ms against
 * `(c WHERE c.k = 2)` and `(c {k: 2})` at 11.5-12.6.
 *
 * An independent fixture with the SAME QUERY STRINGS shows no gap at all, and three candidate causes
 * have been ruled out one at a time (all at 200,000 vertices, median of 7):
 *
 * ```text
 *    no index, 50k        clause  3.9   inline  3.0 / 3.4
 *    hash index on `k`    clause  4.0   inline  3.5 / 3.6     (and the probe indexes AFTER the group)
 *    no index, 200k       clause 21.2   inline 19.7 / 19.2
 *    multi-label edges    clause 22.1   inline 17.6 / 29.2
 * ```
 *
 * So this probe splits the remaining possibilities: it rebuilds the probe's fixture BYTE FOR BYTE —
 * its NDJSON, its `tsDeserialize` loader, `N * 3` edges, `k = i % 50`, the one-in-eleven second edge
 * label, and the four extra `S`/`Univ` nodes — and runs ONE query per process.
 *
 *   - If the gap appears here, it is the FIXTURE, and the next step is to bisect it.
 *   - If it does not, it is `spelling-probe.ts`'s in-process measurement of this group — which
 *     matters more, because that probe is the repo's primary instrument for the defect class this
 *     engine is named for, and its own header says "a flagged group is a finding".
 *
 *   ROW=clause node gql-spelling-replica-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);

/**
 * ⚠️ THE BISECTION (item 1703). The replica reproduces the 38.7x; an independent fixture with the
 * same query strings does not. Each toggle moves ONE property from the replica's value toward the
 * fixture that shows no gap, so exactly one of them should collapse the ratio.
 *
 *   FANOUT=3|5        edges per vertex          (replica 3)
 *   KMOD=50|17        the filtered key's period (replica 50)
 *   SCATTER=0|1       1 makes `to` NONLINEAR, so in-degree varies; the replica's linear `to` is a
 *                     bijection per layer, making the graph in-REGULAR (item 1684's third trap)
 *   EDGEPROPS=1|0     the `w`/`ew` edge properties (replica 1)
 *   EXTRA=1|0         the four `S`/`Univ` nodes    (replica 1)
 *   LOADER=ndjson|api the graph's construction     (replica ndjson)
 *
 * Defaults are the REPLICA's values, so a run with no toggles must still show the gap — that is the
 * control, and without it a collapsed ratio could be any of six changes at once.
 */
const FANOUT = Number(process.env.FANOUT ?? 3);
const KMOD = Number(process.env.KMOD ?? 50);
const SCATTER = process.env.SCATTER === '1';
const EDGEPROPS = process.env.EDGEPROPS !== '0';
const EXTRA = process.env.EXTRA !== '0';
const LOADER = process.env.LOADER ?? 'ndjson';

const edgeTo = (e) =>
  SCATTER ? ((e % N) * 104_729 + Math.floor(e / N) * 977) % N : (e * 7919) % N;
const edgeFrom = (e) => (e * 104_729) % N;
const nodeK = (i) => i % KMOD;

const lines = [];

for (let i = 0; i < N; i += 1) {
  lines.push(
    `{"type":"node","id":"v${i}","labels":["P"],"properties":{"k":${nodeK(i)},"s":"s${i % 100}"}}`,
  );
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const props = EDGEPROPS ? `{"w":${e % 5},"ew":${e % 1000}}` : '{}';

  lines.push(
    `{"type":"edge","id":"e${e}","labels":${e % 11 === 0 ? '["E","F"]' : '["E"]'},"from":"v${edgeFrom(e)}","to":"v${edgeTo(e)}","properties":${props}}`,
  );
}

if (EXTRA) {
  for (let i = 0; i < 4; i += 1) {
    lines.push(
      `{"type":"node","id":"s${i}","labels":["S","Univ"],"properties":{"k":${i},"s":"t${i}"}}`,
    );
  }
}

/** The API loader, for the one toggle NDJSON cannot express by editing a line. */
const buildViaApi = () => {
  const h = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(
      h.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: nodeK(i), s: `s${i % 100}` } }),
    );
  }

  for (let e = 0; e < N * FANOUT; e += 1) {
    h.addEdge({
      id: `e${e}`,
      from: vs[edgeFrom(e)],
      to: vs[edgeTo(e)],
      labels: e % 11 === 0 ? ['E', 'F'] : ['E'],
      properties: EDGEPROPS ? { w: e % 5, ew: e % 1000 } : {},
    });
  }

  if (EXTRA) {
    for (let i = 0; i < 4; i += 1) {
      h.addVertex({ id: `s${i}`, labels: ['S', 'Univ'], properties: { k: i, s: `t${i}` } });
    }
  }

  return h;
};

const g = LOADER === 'api' ? buildViaApi() : deserialize(lines.join('\n'), 'ndjson', new Graph());

const ROWS = {
  clause: 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
  inlineWhere: 'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
  inlineProp: 'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
};

const { ROW } = process.env;

if (ROW === undefined || ROWS[ROW] === undefined) {
  throw new Error(`set ROW to one of: ${Object.keys(ROWS).join(', ')}`);
}

const q = ROWS[ROW];
const count = Number(query(g, q)[0].c);

if (count === 0) {
  throw new Error('the row counted 0 — it would prove nothing');
}

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  query(g, q);
  series.push(performance.now() - t0);
}

/** ⚠️ MEDIAN of the warm reps: this repo's note is that `min` has reversed a verdict's sign. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${ROW.padEnd(12)} median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(9)} count=${String(count).padStart(9)} fanout=${FANOUT} kmod=${KMOD} scatter=${SCATTER ? 1 : 0} edgeprops=${EDGEPROPS ? 1 : 0} extra=${EXTRA ? 1 : 0} loader=${LOADER}`,
);
