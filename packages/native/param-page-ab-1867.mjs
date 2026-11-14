/**
 * THE PARAMETERIZED PAGE, PER SHAPE (item 1867).
 *
 * The family figure (31.6 -> 12.0 ms) mixes shapes. This measures the paginated spellings on their
 * own, against the LITERAL twin as a null control — because the change touches `outputColumnSorts`,
 * which every projection rung reads, so the literal path moving at all would be a regression that
 * the win could hide.
 *
 * ⚠️ ONE SHAPE PER PROCESS is not needed here (no A/B arm is being redistributed within a process:
 * the PRE arm is a different BUILD), but each shape is timed independently and the literal control
 * is measured in the same run as its parameterized twin, so a machine-wide drift moves both.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { k: i % 997, s: `s${i % 31}` } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + h * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
    });
    e += 1;
  }
}

const NODEQ = 'MATCH (n:T) RETURN n.k AS x, n.s AS s ORDER BY x';
const HOPQ = 'MATCH (a:T)-[:E]->(b:T) RETURN b.k AS x, a.k AS y ORDER BY x';

const SHAPES = [
  ['node  OFFSET $s LIMIT $n', `${NODEQ} OFFSET $s LIMIT $n`, { s: 100, n: 20 }],
  ['node  OFFSET 100 LIMIT 20  (CONTROL)', `${NODEQ} OFFSET 100 LIMIT 20`, {}],
  ['node  LIMIT $n', `${NODEQ} LIMIT $n`, { n: 20 }],
  ['node  LIMIT 20              (CONTROL)', `${NODEQ} LIMIT 20`, {}],
  ['hop   OFFSET $s LIMIT $n', `${HOPQ} OFFSET $s LIMIT $n`, { s: 100, n: 20 }],
  ['hop   OFFSET 100 LIMIT 20   (CONTROL)', `${HOPQ} OFFSET 100 LIMIT 20`, {}],
  ['node  ORDER BY only         (CONTROL)', NODEQ, {}],
];

console.log(`${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS} after 2 warm-ups`);
console.log('');
console.log('shape                                    ms     rows');
console.log('------------------------------------------------------');

for (const [name, text, params] of SHAPES) {
  const series = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    const got = query(g, text, params);
    const ms = performance.now() - t0;

    if (r >= 2) {
      series.push(ms);
    }

    rows = got.length;
  }

  series.sort((a, b) => a - b);

  const median = series[series.length >> 1];

  console.log(`${name.padEnd(38)} ${median.toFixed(2).padStart(7)} ${String(rows).padStart(8)}`);
}
