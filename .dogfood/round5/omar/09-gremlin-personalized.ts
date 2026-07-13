import {
  traversal,
  V,
  has,
  in_,
  out,
  toArray,
  groupCount,
  where,
  not,
  without,
  values,
  dedupe,
} from '@lenke/gremlin';

import { buildDataset } from './data.ts';

const d = buildDataset();
const g = d.g;
const U = 'u7';

// JS truth (same score definition as 05)
const owned = new Set(d.purchased.filter((p) => p.user === U).map((p) => p.item));
const usersItems = new Map<string, string[]>();
for (const p of d.purchased) {
  if (!usersItems.has(p.user)) usersItems.set(p.user, []);
  usersItems.get(p.user)!.push(p.item);
}
const byItem = new Map<string, string[]>();
for (const p of d.purchased) {
  if (!byItem.has(p.item)) byItem.set(p.item, []);
  byItem.get(p.item)!.push(p.user);
}
const score = new Map<string, number>();
for (const s of owned)
  for (const other of byItem.get(s) ?? []) {
    if (other === U) continue;
    for (const rec of usersItems.get(other) ?? []) {
      if (owned.has(rec)) continue;
      score.set(rec, (score.get(rec) ?? 0) + 1);
    }
  }
const jsTop = [...score.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10);

// Gremlin: two-hop CF with exclude-owned via without() predicate; groupCount for scores.
const ownedArr = [...owned];
const gremMap = toArray(
  traversal(
    V(),
    has('uid', U),
    out('PURCHASED'), // items U bought
    in_('PURCHASED'), // other users who bought them
    where(not(has('uid', U))), // exclude self
    out('PURCHASED'), // items those others bought
    has('iid', without(...ownedArr)), // exclude items U already owns
    groupCount().by('iid'),
  ),
  g,
)[0] as Map<string, number>;

// rank in JS (in-engine ranking of a map is unsupported)
const gremTop = [...gremMap.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10);

console.log('JS   top10:', jsTop);
console.log('Grem top10:', gremTop);
console.log('MATCH counts JS==Gremlin:', JSON.stringify(jsTop) === JSON.stringify(gremTop));
