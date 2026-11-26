/**
 * **DOES ADDING `ORDER BY` COST TS 45x WHERE IT COSTS NATIVE 1.35x? (item 2259)**
 *
 * The `ts,wasm` bench table holds two rows that, read together, say something extreme:
 *
 *     traverse 1-hop project              ts  18.1 ms   wasm 215.6
 *     traverse 1-hop project + order by   ts 827.5      wasm 292.0
 *     -> adding ORDER BY costs TS 45.7x and native 1.35x
 *
 * That is exactly [[accounted-shape-hides-a-term]]'s rule applied — **vary ONE thing in an accounted row
 * before dismissing it** — and nobody has read these two rows against each other. But ORDER BY is
 * heavily worked (items 1902/1903/1905/1929/1930/1960/1961/1962, several ships), so the first job is to
 * confirm the effect exists at all rather than to explain it.
 *
 * **THE OBVIOUS CONFOUND, CHECKED BY A CONTROL:** an unordered projection may stream lazily while a sort
 * must materialize every row. So `projectAll` forces full materialization of the unordered form (it reads
 * `.length`, which the sorted arm also pays), making the two arms differ only in the SORT.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { name: `n${i % 9973}`, k: i % 97 } });
}

/* Split on the REPEAT INDEX, or one vertex's whole fan-out lands on ONE target (the recorded defect). */
let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e++}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`)!,
      labels: ['KNOWS'],
      properties: {},
    });
  }
}

const ARMS: Array<[string, string]> = [
  ['project', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'],
  ['project+order', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n'],
  ['project+order k', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.k AS n ORDER BY n'],
  ['scan+order', 'MATCH (a:Person) RETURN a.name AS n ORDER BY n'],
  ['count', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c'],
];

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(`  N=${N} vertices, ${N * FANOUT} edges, REPS=${REPS}\n`);
console.log(
  `  ${'arm'.padEnd(17)} ${'median'.padStart(9)} ${'rows'.padStart(8)} ${'ns/row'.padStart(8)}`,
);

const out = new Map<string, number>();

for (const [name, text] of ARMS) {
  const series: number[] = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    /* `.length` forces full materialization on BOTH arms, so the difference is the SORT alone. */
    const n = query(g, text, {}).length;

    series.push(performance.now() - t);
    rows = n;
  }

  const m = med(series.slice(2));

  out.set(name, m);
  console.log(
    `  ${name.padEnd(17)} ${m.toFixed(1).padStart(9)} ${String(rows).padStart(8)} ${rows === 0 ? '-' : ((m * 1e6) / rows).toFixed(0).padStart(8)}`,
  );
}

const p = out.get('project') ?? 0;
const o = out.get('project+order') ?? 0;

console.log(
  `\n  ORDER BY costs ${(o / Math.max(p, 1e-9)).toFixed(2)}x on this shape (bench implied 45.7x for ts, 1.35x for wasm)`,
);
