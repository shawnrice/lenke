/**
 * DOES THE FUSED HOP WALK HAND BACK THE CANONICAL `Vertex` INSTANCE? (item 1770)
 *
 * Item 1770's ablation put `far.properties[valueKey]` at 4.0x of `V().out(T).values(k)`, and a
 * separate micro priced the keyed load itself at ~1.5 ns — against ~60 ns/row in situ, 40x apart.
 * So the cost is the `properties` GETTER, not the load. The getter caches its box PER INSTANCE:
 *
 *     this.#box ??= this.#graph.elementProperties.get(this.#id);
 *
 * If the walk yields a FRESH `Vertex` per row, `#box` is `undefined` every time and every row pays
 * a string-keyed `Map.get` over the whole element map — which is the right order of magnitude. If it
 * yields the canonical instance, each vertex pays that once and the amortized cost is ~10 ns/row,
 * leaving the 60 ns unexplained. The two cases call for completely different work, so this measures
 * which it is rather than assuming.
 *
 * Object identity is the whole question, so `distinctObjects` vs `distinctIds` is the reading: equal
 * means one instance per id (canonical), and a larger object count means fresh instances.
 */
import { Graph } from '@lenke/core';
import { out, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 2000);
const FANOUT = Number(process.env.FANOUT ?? 5);

const g = new Graph();
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: 20 + (i % 60) } }));
}

for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    const to = (i * 7 + rep * 104_729 + 1) % NODES;

    g.addEdge({ id: `e${rep}-${i}`, from: verts[i], to: verts[to], labels: ['KNOWS'] });
  }
}

const rows = toArray(traversal(V(), out('KNOWS')), g);
const objects = new Set(rows);
const ids = new Set(rows.map((v) => v.id));
let canonical = 0;

for (const v of rows) {
  if (v === g.getVertexById(v.id)) {
    canonical += 1;
  }
}

console.log(
  JSON.stringify({
    rows: rows.length,
    canonical,
    fresh: rows.length - canonical,
    distinctObjects: objects.size,
    distinctIds: ids.size,
    verdict: objects.size === ids.size ? 'CANONICAL (one instance per id)' : 'FRESH INSTANCES',
  }),
);
