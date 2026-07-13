// Confirm: (1) shortestPath ignores direction; (2) repeat(out).until() is a CORRECT directional
// alternative for all 600 ordered pairs, verified vs directed BFS.
import {
  toArray,
  traversal,
  V,
  has,
  out,
  path,
  repeat,
  shortestPath,
  ShortestPath,
} from '@lenke/gremlin';

import { buildGrid, bfsHops } from './graph';

const { g, adj, names } = buildGrid(5, 5);

let repeatFail = 0;
let shortestWrongDir = 0; // cases where shortestPath returns a path but directed BFS says unreachable
let repeatChecked = 0;
const egs: string[] = [];

for (const s of names) {
  for (const d of names) {
    if (s === d) continue;
    const refHop = bfsHops(adj, s, d); // DIRECTED
    repeatChecked++;

    // Directional workaround: repeat(out).until(reach d), min path length
    const rpaths = toArray(
      traversal(
        V(),
        has('name', s),
        repeat(out('ROAD')).until(has('name', d)).times(24),
        has('name', d),
        path(),
      ),
      g,
    ) as any[][];
    const rHop = rpaths.length ? Math.min(...rpaths.map((p) => p.length - 1)) : Infinity;
    // validate each returned path is directed-valid
    let allValid = true;
    for (const p of rpaths) {
      const seq = p.map((v: any) => v.properties.name as string);
      let ok = seq[0] === s && seq.at(-1) === d;
      for (let i = 0; i + 1 < seq.length && ok; i++)
        ok = (adj.get(seq[i]) ?? []).some((e) => e.to === seq[i + 1]);
      allValid &&= ok;
    }
    if (rHop !== refHop || !allValid) {
      repeatFail++;
      if (egs.length < 10)
        egs.push(`repeat ${s}->${d}: got ${rHop} valid=${allValid} want ${refHop}`);
    }

    // shortestPath direction check
    if (refHop === Infinity) {
      const sp = toArray(
        traversal(V(), has('name', s), shortestPath().with(ShortestPath.target, has('name', d))),
        g,
      ) as any[][];
      if (sp.some((p) => p.length)) shortestWrongDir++;
    }
  }
}

console.log(
  `repeat(out).until() directional shortest: ${repeatFail} failures of ${repeatChecked} pairs`,
);
if (egs.length) egs.forEach((e) => console.log('  ', e));
console.log(
  `shortestPath() returned a path for ${shortestWrongDir} pairs that are UNREACHABLE in the directed graph (wrong-way routes).`,
);
