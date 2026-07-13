// Smoke-test the exact mechanisms we depend on:
//  - GQL variable-length patterns: -[:X]->*(b), -[:X]->+(b), -[:X]->{1,N}(b)
//    * zero-hop inclusion of `*` (does it include the start?)
//    * whether the endpoint binds and can be RETURNed distinctly
//  - Gremlin repeat().until()/emit()/emitBefore()/times()
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { run, toArray, traversal, V, out, values, has, repeat, dedupe } from '@lenke/gremlin';

const g = new Graph();
// chain: a -> b -> c -> d  (SUBCLASS_OF)
const a = g.addVertex({ labels: ['Class'], properties: { name: 'a' } });
const b = g.addVertex({ labels: ['Class'], properties: { name: 'b' } });
const c = g.addVertex({ labels: ['Class'], properties: { name: 'c' } });
const d = g.addVertex({ labels: ['Class'], properties: { name: 'd' } });
g.addEdge({ from: a, to: b, labels: ['SUBCLASS_OF'], properties: {} });
g.addEdge({ from: b, to: c, labels: ['SUBCLASS_OF'], properties: {} });
g.addEdge({ from: c, to: d, labels: ['SUBCLASS_OF'], properties: {} });

const S = (rows: any[], key: string) => new Set(rows.map((r) => r[key]));
const show = (label: string, s: Set<unknown>) =>
  console.log(label, '=>', JSON.stringify([...s].sort()));

console.log('=== GQL var-length ===');
// STAR: superclasses of a including a? (* is {0,})
show(
  'star  MATCH (a{name:a})-[:SUBCLASS_OF]->*(s) RETURN s.name',
  S(query(g, `MATCH (x:Class {name:'a'})-[:SUBCLASS_OF]->*(s) RETURN s.name AS n`), 'n'),
);
// PLUS: {1,}
show(
  'plus  MATCH (a{name:a})-[:SUBCLASS_OF]->+(s) RETURN s.name',
  S(query(g, `MATCH (x:Class {name:'a'})-[:SUBCLASS_OF]->+(s) RETURN s.name AS n`), 'n'),
);
// bounded {1,2}
show(
  '{1,2} MATCH (a{name:a})-[:SUBCLASS_OF]->{1,2}(s) RETURN s.name',
  S(query(g, `MATCH (x:Class {name:'a'})-[:SUBCLASS_OF]->{1,2}(s) RETURN s.name AS n`), 'n'),
);
// {0,2}
show(
  '{0,2}',
  S(query(g, `MATCH (x:Class {name:'a'})-[:SUBCLASS_OF]->{0,2}(s) RETURN s.name AS n`), 'n'),
);
// DISTINCT needed?
console.log(
  'raw star rows (no distinct):',
  query(g, `MATCH (x:Class {name:'a'})-[:SUBCLASS_OF]->*(s) RETURN s.name AS n`),
);

console.log('=== Gremlin repeat ===');
console.log(
  'repeat(out).emit() dedupe  [post-form, excludes lvl0]:',
  toArray(traversal(V(), has('name', 'a'), repeat(out('SUBCLASS_OF')).emit(), values('name')), g),
);
console.log(
  'repeat(out).emitBefore() dedupe [includes start]:',
  toArray(
    traversal(
      V(),
      has('name', 'a'),
      repeat(out('SUBCLASS_OF')).emitBefore(),
      dedupe(),
      values('name'),
    ),
    g,
  ),
);
