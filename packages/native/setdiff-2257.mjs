/**
 * **WHAT DOES GQL `SET` DO THAT GREMLIN `property` DOES NOT? (item 2257)** Item 2255 confirmed the gap
 * at **2.60x on the write alone** (351 ns/row against 135, over a 61 ns host floor) and item 2256 validated
 * the decomposition. The profile is diffuse — GC 12%, then eight frames at 2-9% — so no single frame
 * nominates itself.
 *
 * **BUT THE TWO SURFACES PERFORM THE SAME MUTATION**, so a differential profile answers it directly:
 * **the frames present in the GQL arm and ABSENT in the Gremlin arm are the gap.** That is a sharper
 * question than "what is hot in GQL", which is what the diffuse profile already answered.
 *
 * `PROF_ARM` picks one surface — ONE ARM PER PROCESS, so neither pollutes the other's inline caches.
 *
 * A write is not idempotent, so a profile normally cannot exclude the fixture build. **Item 1933's
 * measurement is what makes this possible: `SET n.n = n.n` costs the same as a real change (416 vs 404
 * ns/row), so the per-row cost is VALUE-INDEPENDENT and one graph can be rewritten many times with no
 * rebuild inside the profile.** The Gremlin arm writes a constant for the same reason.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, property, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 25);
const ARM = process.env.PROF_ARM ?? 'gql';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { n: i % 97, w: i % 13 } });
}

const gremPlan = traversal(V(), property('n', 1));
let sink = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM === 'gql') {
    /* Value-independent per item 1933, so no rebuild is needed between rounds. */
    sink += query(g, 'MATCH (n:T) SET n.n = n.n', {}).length;
  } else {
    sink += toArray(gremPlan, g).length;
  }
}

console.log(`  arm=${ARM} rounds=${ROUNDS} vertices=${N} sink=${sink}`);
