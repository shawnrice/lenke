import { query } from '@lenke/gql';

import { buildDataset } from './data.ts';

const d = buildDataset();
const g = d.g;
const U = 'u7';

// ---------- JS ground truth ----------
const owned = new Set(d.purchased.filter((p) => p.user === U).map((p) => p.item));
// similar users = users who share >=1 purchased item with U (excluding U)
const byItem = new Map<string, string[]>();
for (const p of d.purchased) {
  if (!byItem.has(p.item)) byItem.set(p.item, []);
  byItem.get(p.item)!.push(p.user);
}
// score(rec) = number of (other,sharedItem) paths: for each item U owns,
// each other buyer of that item, then each rec that other bought (rec not owned).
// This matches: MATCH (me)-[:P]->(s)<-[:P]-(other)-[:P]->(rec)
const usersByItemPurchases = new Map<string, string[]>(); // user -> items they bought
for (const p of d.purchased) {
  if (!usersByItemPurchases.has(p.user)) usersByItemPurchases.set(p.user, []);
  usersByItemPurchases.get(p.user)!.push(p.item);
}
const score = new Map<string, number>();
for (const s of owned) {
  for (const other of byItem.get(s) ?? []) {
    if (other === U) continue;
    for (const rec of usersByItemPurchases.get(other) ?? []) {
      if (owned.has(rec)) continue;
      score.set(rec, (score.get(rec) ?? 0) + 1);
    }
  }
}
const jsTop = [...score.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10);
console.log('JS personalized top10 for', U, ':', jsTop);
console.log('U owns', owned.size, 'items');

// ---------- GQL: exclude-owned via NOT EXISTS ----------
const gqlRows = query(
  g,
  `
  MATCH (me:User {uid:$u})-[:PURCHASED]->(s:Item)<-[:PURCHASED]-(other:User)-[:PURCHASED]->(rec:Item)
  WHERE other <> me
    AND NOT EXISTS { MATCH (me)-[:PURCHASED]->(rec) }
  RETURN rec.iid AS item, count(*) AS score
  ORDER BY score DESC, item ASC
  LIMIT 10
`,
  { u: U },
);
console.log(
  'GQL personalized top10:',
  gqlRows.map((r) => [r.item, r.score]),
);

// equality check
const match = JSON.stringify(jsTop) === JSON.stringify(gqlRows.map((r) => [r.item, r.score]));
console.log('MATCH JS==GQL:', match);
