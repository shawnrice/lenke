import { query } from '@lenke/gql';
import { traversal, V, has, out, toArray, groupCount } from '@lenke/gremlin';

import { buildDataset } from './data.ts';

const d = buildDataset();
const g = d.g;
const U = 'u7';

// item -> categoryId map
const itemCat = new Map(d.items.map((i) => [i.id, i.categoryId]));
const catName = new Map(d.categories.map((c) => [c.id, c.name]));

// ================= CATEGORY AFFINITY =================
const owned = d.purchased.filter((p) => p.user === U);
const catCnt = new Map<string, number>();
for (const p of owned) {
  const c = itemCat.get(p.item)!;
  catCnt.set(c, (catCnt.get(c) ?? 0) + 1);
}
const jsCat = [...catCnt.entries()]
  .map(([c, n]) => [catName.get(c)!, n] as [string, number])
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log('JS category affinity:', jsCat);

const gqlCat = query(
  g,
  `
  MATCH (me:User {uid:$u})-[:PURCHASED]->(i:Item)-[:IN_CATEGORY]->(c:Category)
  RETURN c.name AS cat, count(*) AS n
  ORDER BY n DESC, cat ASC
`,
  { u: U },
);
console.log(
  'GQL category affinity:',
  gqlCat.map((r) => [r.cat, r.n]),
);

// Gremlin category affinity (groupCount works)
const gremCat = toArray(
  traversal(V(), has('uid', U), out('PURCHASED'), out('IN_CATEGORY'), groupCount().by('name')),
  g,
)[0] as Map<string, number>;
console.log('Gremlin category affinity map:', gremCat);

// ================= HAVING (filter on aggregate) =================
// items co-bought with i1 MORE THAN 400 times
const X = 'i1';
const buyersOfX = new Set(d.purchased.filter((p) => p.item === X).map((p) => p.user));
const co = new Map<string, number>();
for (const p of d.purchased) {
  if (p.item === X) continue;
  if (buyersOfX.has(p.user)) co.set(p.item, (co.get(p.item) ?? 0) + 1);
}
const jsHaving = [...co.entries()]
  .filter(([, n]) => n > 400)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log('JS having(>400):', jsHaving);

// GQL HAVING via WITH ... WHERE on the aggregate
const gqlHaving = query(
  g,
  `
  MATCH (x:Item {iid:$x})<-[:PURCHASED]-(u:User)-[:PURCHASED]->(y:Item)
  WHERE y.iid <> $x
  WITH y.iid AS item, count(*) AS coBought
  WHERE coBought > 400
  RETURN item, coBought
  ORDER BY coBought DESC, item ASC
`,
  { x: X },
);
console.log(
  'GQL having(>400):',
  gqlHaving.map((r) => [r.item, r.coBought]),
);

// ================= NORMALIZED ITEM-ITEM SIMILARITY (cosine on binary) =================
// sim(X,Y) = coBought(X,Y) / sqrt(pop(X)*pop(Y))
const popX = buyersOfX.size;
const popByItem = new Map<string, number>();
for (const p of d.purchased) popByItem.set(p.item, (popByItem.get(p.item) ?? 0) + 1);
const jsSim = [...co.entries()]
  .map(([y, c]) => [y, c / Math.sqrt(popX * popByItem.get(y)!)] as [string, number])
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10);
console.log(
  'JS normalized sim top10:',
  jsSim.map(([y, s]) => [y, +s.toFixed(4)]),
);

// GQL: needs pop(Y) — COUNT{} subquery per Y, and $popX param
const gqlSim = query(
  g,
  `
  MATCH (x:Item {iid:$x})<-[:PURCHASED]-(u:User)-[:PURCHASED]->(y:Item)
  WHERE y.iid <> $x
  WITH y, count(*) AS co
  RETURN y.iid AS item,
         co / sqrt($popX * COUNT { MATCH (:User)-[:PURCHASED]->(y) }) AS sim
  ORDER BY sim DESC, item ASC
  LIMIT 10
`,
  { x: X, popX },
);
console.log(
  'GQL normalized sim top10:',
  gqlSim.map((r) => [r.item, +Number(r.sim).toFixed(4)]),
);
