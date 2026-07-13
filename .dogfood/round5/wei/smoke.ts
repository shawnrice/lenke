import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const a = g.addVertex({
  labels: ['Article'],
  properties: { title: 'Hello World', body: 'foo bar baz', views: 10 },
});
const b = g.addVertex({
  labels: ['Article'],
  properties: { title: 'Goodbye', body: 'foo qux', views: 3 },
});

console.log(
  'CONTAINS:',
  query(g, `MATCH (a:Article) WHERE a.body CONTAINS 'foo' RETURN a.title AS t`),
);
console.log('lower:', query(g, `MATCH (a:Article) RETURN lower(a.title) AS lt`));
console.log('count:', query(g, `MATCH (a:Article) RETURN count(*) AS n`));
