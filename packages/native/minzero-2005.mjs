/**
 * THE `{0,k}` ACYCLIC COUNT DIVERGENCE (item 2005, a bug from item 2002).
 *
 * The differential fuzzer caught `MATCH ACYCLIC (a:T)<-[:F]-{0,2}(b) RETURN count(*)` as a VALUE
 * divergence — "the engines disagree about the ANSWER, which no registry entry may excuse". A
 * quantifier with `min = 0` admits the ZERO-LENGTH path, one row per source, and item 2002's acyclic
 * count route only ever counts `len >= 1`.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();

for (const id of ['a', 'b', 'c']) {
  g.addVertex({ id, labels: ['T'], properties: { n: id } });
}

g.addEdge({
  id: 'e1',
  from: g.getVertexById('a'),
  to: g.getVertexById('b'),
  labels: ['E'],
  properties: {},
});
g.addEdge({
  id: 'e2',
  from: g.getVertexById('b'),
  to: g.getVertexById('c'),
  labels: ['E'],
  properties: {},
});

const q = (t) => {
  try {
    return JSON.stringify([...query(g, t, {})]);
  } catch (err) {
    return `ERR ${String(err.code ?? err.message).slice(0, 20)}`;
  }
};

console.log(`|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)}  chain a->b->c\n`);
console.log('bound   mode       count(*)              DISTINCT b.n');

for (const bound of ['{0,1}', '{0,2}', '{1,2}', '{0,0}']) {
  for (const [mn, kw] of [
    ['WALK', 'MATCH'],
    ['TRAIL', 'MATCH TRAIL'],
    ['ACYCLIC', 'MATCH ACYCLIC'],
  ]) {
    const c = q(`${kw} (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`);
    const d = q(`${kw} (a:T)-[:E]->${bound}(b:T) RETURN DISTINCT b.n AS x`);

    console.log(`${bound.padEnd(7)} ${mn.padEnd(10)} ${c.padEnd(21)} ${d}`);
  }
}

console.log(
  '\n# For `{0,k}` every mode must include the ZERO-LENGTH path: one row per source, where the',
  '\n#    endpoint IS the start. ACYCLIC answering fewer rows than WALK at `{0,k}` by exactly the',
  '\n#    source count is the signature of the omission.',
);
