import { query } from '@lenke/gql';

import { buildDataset } from './data.ts';
const d = buildDataset();
const g = d.g;

function probe(label: string, q: string, params?: any) {
  try {
    const r = query(g, q, params);
    console.log(label, 'OK:', JSON.stringify(r).slice(0, 160));
  } catch (e: any) {
    console.log(label, 'ERR', e.code ?? e.constructor?.name, '-', String(e.message).slice(0, 120));
  }
}

// count(DISTINCT other) — distinct similar users rather than paths
probe(
  'count(DISTINCT)',
  `
  MATCH (me:User {uid:'u7'})-[:PURCHASED]->(:Item)<-[:PURCHASED]-(other:User)-[:PURCHASED]->(rec:Item)
  WHERE other <> me
  RETURN rec.iid AS item, count(DISTINCT other) AS users
  ORDER BY users DESC LIMIT 3`,
);

// collect_list to build a recommendation list per category
probe(
  'collect_list',
  `
  MATCH (me:User {uid:'u7'})-[:PURCHASED]->(i:Item)-[:IN_CATEGORY]->(c:Category)
  RETURN c.name AS cat, collect_list(i.iid) AS items`,
);

// sum of edge weights (quantity) per item
probe(
  'sum(weight)',
  `
  MATCH (:User)-[p:PURCHASED]->(i:Item)
  RETURN i.iid AS item, sum(p.weight) AS qty
  ORDER BY qty DESC LIMIT 3`,
);

// avg rating per item with HAVING >= 4
probe(
  'avg rating + HAVING',
  `
  MATCH (:User)-[r:RATED]->(i:Item)
  WITH i.iid AS item, avg(r.rating) AS ar, count(*) AS n
  WHERE n >= 50 AND ar >= 3.5
  RETURN item, ar, n ORDER BY ar DESC LIMIT 3`,
);

// known: reserved-word alias 'count'
probe('reserved alias count', `MATCH (i:Item) RETURN count(*) AS count`);

// three-hop with dedup: items in same category as items U bought, that U doesn't own
probe(
  '3-hop dedup',
  `
  MATCH (me:User {uid:'u7'})-[:PURCHASED]->(:Item)-[:IN_CATEGORY]->(:Category)<-[:IN_CATEGORY]-(rec:Item)
  WHERE NOT EXISTS { MATCH (me)-[:PURCHASED]->(rec) }
  RETURN count(DISTINCT rec) AS candidates`,
);
