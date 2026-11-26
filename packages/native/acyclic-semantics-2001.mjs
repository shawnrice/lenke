/**
 * WHAT EXACTLY DOES A QUANTIFIED PATH COUNT COUNT? (item 2001)
 *
 * **THIS EXISTS BECAUSE I PROVED AN ARITHMETIC AGAINST MY OWN MODEL AND NOT AGAINST THE
 * ENGINE.** `acyclic-correction-2001.mjs` derived an ACYCLIC correction and checked its
 * inclusion-exclusion against a brute-force enumeration of 2-WALKS — both sides mine, both agreeing,
 * and both off by exactly `selfLoops` from what the engine answers. `acyclic-selfloop-2001.mjs` then
 * showed the engine is RIGHT (ACYCLIC is 0 at every bound on one vertex with one self-loop), so the
 * wrong model was mine: on `a->a` + `a->b`, WALK `{1,2}` answers **3** where enumerating edge
 * sequences gives **4**.
 *
 * **SO THE ROWS HAVE TO BE READ, NOT COUNTED.** A `count(*)` cannot distinguish "paths" from
 * "endpoint pairs" from "deduplicated bindings", and those have different corrections. This prints
 * the actual bindings per mode and bound, which is the only thing that settles it.
 *
 * This is the same lesson as [[vary-only-the-projection]] pointed the other way: there, changing the
 * projection revealed a rung gap; here, changing the projection from `count(*)` to the bindings
 * themselves reveals what the count was ever counting.
 *
 *     bun acyclic-semantics-2001.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();

g.addVertex({ id: 'a', labels: ['T'], properties: { n: 1 } });
g.addVertex({ id: 'b', labels: ['T'], properties: { n: 2 } });
g.addEdge({
  id: 'l',
  from: g.getVertexById('a'),
  to: g.getVertexById('a'),
  labels: ['E'],
  properties: {},
});
g.addEdge({
  id: 'e',
  from: g.getVertexById('a'),
  to: g.getVertexById('b'),
  labels: ['E'],
  properties: {},
});

/*
 * A SECOND PARALLEL EDGE `a->b` IS ADDED BELOW IN THE SECOND BLOCK, not here. Multiplicity is the
 * axis that separates "endpoint pairs" from "paths": if two distinct edges a->b give ONE row, the
 * count is over endpoint pairs; if they give two, it is over paths.
 */
const BOUNDS = ['{1,1}', '{1,2}', '{2,2}'];
const MODES = { WALK: 'MATCH', TRAIL: 'MATCH TRAIL', ACYCLIC: 'MATCH ACYCLIC' };

const show = (graph, label) => {
  console.log(
    `\n=== ${label}  |V|=${String(graph.vertexCount)} |E|=${String(graph.edgeCount)} ===`,
  );

  for (const [mn, mt] of Object.entries(MODES)) {
    for (const bound of BOUNDS) {
      const text = `${mt} (x:T)-[:E]->${bound}(y:T) RETURN x.n AS xn, y.n AS yn`;
      const rows = [...query(graph, text, {})].map((r) => `${String(r.xn)}->${String(r.yn)}`);

      console.log(
        `${mn.padEnd(8)} ${bound.padEnd(7)} ${String(rows.length).padStart(2)}  ${rows.join(' ')}`,
      );
    }
  }
};

show(g, 'a->a (loop) + a->b');

const g2 = new Graph();

g2.addVertex({ id: 'a', labels: ['T'], properties: { n: 1 } });
g2.addVertex({ id: 'b', labels: ['T'], properties: { n: 2 } });

for (const id of ['e1', 'e2']) {
  g2.addEdge({
    id,
    from: g2.getVertexById('a'),
    to: g2.getVertexById('b'),
    labels: ['E'],
    properties: {},
  });
}

show(g2, 'two PARALLEL a->b edges, no loop');
