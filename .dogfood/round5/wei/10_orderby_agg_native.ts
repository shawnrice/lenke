import { query as tsQuery } from '@lenke/gql';
import { createEmptyGraph } from '@lenke/native';
import { createNodeBackend } from '@lenke/node/backend';

// Does the "aggregate only in ORDER BY" footgun behave the same on native?
import { buildCorpus } from './corpus';

const { g } = buildCorpus(7, 30); // small corpus, TS graph

const q = `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag ORDER BY count(*) DESC`;
const tsRows = tsQuery(g, q);
console.log('TS rows (aggregate only in ORDER BY):', tsRows.length);
console.log('  first 3:', JSON.stringify(tsRows.slice(0, 3)));

// Build native equivalent
const nG2 = createEmptyGraph(createNodeBackend());
for (const v of g.vertices) {
  if (v.labels.has('Article')) {
    nG2.query(`INSERT (:Article {title: $t})`, { t: v.properties.title });
  }
}
// Add tag edges structurally: recreate from TS edges
// (map by title since we didn't keep ids). Good enough: count TAGGED per article.
let tagged = 0;
for (const e of g.edges) if (e.labels.has('TAGGED')) tagged++;
console.log('  TS TAGGED edge count (== expected rows if ungrouped):', tagged);

// Native: run the footgun on a native graph built with proper edges
const nG3 = createEmptyGraph(createNodeBackend());
// insert articles + tags + edges via GQL
for (const v of g.vertices) {
  if (v.labels.has('Article')) nG3.query(`INSERT (:Article {aid: $id})`, { id: v.id });
  if (v.labels.has('Tag')) nG3.query(`INSERT (:Tag {name: $n})`, { n: v.properties.name });
}
for (const e of g.edges) {
  if (e.labels.has('TAGGED')) {
    nG3.query(`MATCH (a:Article {aid: $aid}), (t:Tag {name: $tn}) INSERT (a)-[:TAGGED]->(t)`, {
      aid: e.from.id,
      tn: e.to.properties.name,
    });
  }
}
const nRows = nG3.query(q) as any[];
console.log('NATIVE rows (aggregate only in ORDER BY):', nRows.length);
console.log('  first 3:', JSON.stringify(nRows.slice(0, 3)));
console.log('  => both engines ungroup the same way:', tsRows.length === nRows.length);
