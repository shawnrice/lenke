// Exhaustive correctness sweep: every ordered pair, GQL var-length + Gremlin shortestPath vs BFS.
import { query } from '@lenke/gql';
import {
  toArray,
  traversal,
  V,
  has,
  out,
  shortestPath,
  ShortestPath,
  repeat,
  values,
  dedupe,
} from '@lenke/gremlin';

import { buildGrid, bfsHops, reachableAll } from './graph';

const { g, adj, names } = buildGrid(5, 5);

let gqlReachFail = 0;
let gremShortFail = 0;
let gqlHopFail = 0;
let checked = 0;
const failures: string[] = [];

// Precompute Gremlin shortestPath from every source to every target in one query per source.
for (const s of names) {
  // reachable set via GQL +
  const rows = query(g, `MATCH (a:Node {name:$s})-[:ROAD]->+(b) RETURN DISTINCT b.name AS n`, {
    s,
  });
  const gqlReach = new Set(rows.map((r) => r.n as string));
  const ref = reachableAll(adj, s);
  if (gqlReach.size !== ref.size || [...ref].some((x) => !gqlReach.has(x))) {
    gqlReachFail++;
    failures.push(`GQL reach ${s}: got ${gqlReach.size} want ${ref.size}`);
  }

  for (const d of names) {
    if (s === d) continue;
    checked++;
    const refHop = bfsHops(adj, s, d);

    // Gremlin shortestPath hop length
    const paths = toArray(
      traversal(V(), has('name', s), shortestPath().with(ShortestPath.target, has('name', d))),
      g,
    ) as any[][];
    const nonEmpty = paths.filter((p) => p.length);
    const gremHop = nonEmpty.length ? Math.min(...nonEmpty.map((p) => p.length - 1)) : Infinity;
    if (gremHop !== refHop) {
      gremShortFail++;
      if (failures.length < 40)
        failures.push(`Grem shortestPath ${s}->${d}: got ${gremHop} want ${refHop}`);
    }
    // verify every returned path is actually a valid path of that length in the ref graph
    for (const p of nonEmpty) {
      const seq = p.map((v: any) => v.properties.name as string);
      let valid = seq[0] === s && seq[seq.length - 1] === d;
      for (let i = 0; i + 1 < seq.length && valid; i++) {
        valid = (adj.get(seq[i]) ?? []).some((e) => e.to === seq[i + 1]);
      }
      if (!valid) {
        gremShortFail++;
        if (failures.length < 40) failures.push(`Grem INVALID path ${s}->${d}: ${seq.join('>')}`);
      }
    }
  }
}

// GQL hop-count via min-N quantifier scan, spot-checked on a sample of pairs
const sample: [string, string][] = [];
for (let i = 0; i < names.length; i += 3)
  for (let j = 0; j < names.length; j += 5) sample.push([names[i], names[j]]);
for (const [s, d] of sample) {
  if (s === d) continue;
  const refHop = bfsHops(adj, s, d);
  let found = Infinity;
  for (let N = 1; N <= 30; N++) {
    const r = query(
      g,
      `MATCH (a:Node {name:$s})-[:ROAD]->{${N}}(b:Node {name:$d}) RETURN count(*) AS c`,
      { s, d },
    );
    if ((r[0].c as number) > 0) {
      found = N;
      break;
    }
  }
  if (found !== refHop) {
    gqlHopFail++;
    failures.push(`GQL min-N ${s}->${d}: got ${found} want ${refHop}`);
  }
}

console.log(`Checked ${checked} ordered pairs (25 nodes).`);
console.log(`GQL reachable-set failures : ${gqlReachFail}`);
console.log(`Gremlin shortestPath fails : ${gremShortFail}`);
console.log(`GQL min-N hop-scan fails   : ${gqlHopFail} (of ${sample.length} sampled)`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(' ', f));
} else console.log('\nALL CORRECT.');
