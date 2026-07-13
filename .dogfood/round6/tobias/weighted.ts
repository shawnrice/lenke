// Weighted (min-cost) routing via path enumeration + JS reduce, verified vs Dijkstra.
// Neither engine has an in-engine weighted-shortest-path (no sack / no fixpoint) — this shows
// the JS-assisted ceiling and confirms correctness.
import { toArray, traversal, V, has, out, path, repeat } from '@lenke/gremlin';

import { buildGrid, dijkstra } from './graph';

const { g, adj } = buildGrid(4, 4);

function edgeW(from: string, to: string): number {
  return (adj.get(from) ?? []).find((e) => e.to === to)!.w;
}

const pairs: [string, string][] = [
  ['n_0_0', 'n_3_3'],
  ['n_0_0', 'n_2_2'],
  ['n_1_0', 'n_3_3'],
];

console.log('=== Weighted min-cost path (enumerate + JS reduce) vs Dijkstra ===');
for (const [s, d] of pairs) {
  const ref = dijkstra(adj, s, d);

  // Enumerate directed paths s->d (repeat(out).until(d).path()), sum edge weights per path, take min.
  const vpaths = toArray(
    traversal(
      V(),
      has('name', s),
      repeat(out('ROAD')).until(has('name', d)).times(30),
      has('name', d),
      path(),
    ),
    g,
  ) as any[][];

  let best = Infinity;
  let bestSeq: string[] = [];
  for (const p of vpaths) {
    const seq = p.map((v: any) => v.properties.name as string);
    let cost = 0;
    for (let i = 0; i + 1 < seq.length; i++) cost += edgeW(seq[i], seq[i + 1]);
    if (cost < best) {
      best = cost;
      bestSeq = seq;
    }
  }
  console.log(
    `${s}->${d}: dijkstra=${ref} enum-min=${best} [${ref === best ? 'OK' : 'MISMATCH'}]  paths=${vpaths.length} best=${bestSeq.join('>')}`,
  );
}
