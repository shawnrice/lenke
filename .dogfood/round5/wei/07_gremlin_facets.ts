import { query } from '@lenke/gql';
import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  groupCount,
  values,
  count,
  toArray,
  run,
} from '@lenke/gremlin';

// Cross-check GQL faceted counts against Gremlin groupCount / count.
import { buildCorpus } from './corpus';

const { g, meta } = buildCorpus();

function assertEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  console.log(
    `${a === e ? 'OK ' : 'FAIL'} ${label}${a === e ? '' : `\n   actual=${a}\n   expected=${e}`}`,
  );
}

// === Gremlin groupCount over category ===
const gc = toArray(traversal(V(), hasLabel('Article'), values('category'), groupCount()), g);
console.log('gremlin groupCount(category):', JSON.stringify(gc));
// groupCount yields a single Map/object. Normalize.
const gcObj = gc[0] instanceof Map ? Object.fromEntries(gc[0] as Map<string, number>) : gc[0];
assertEq('gremlin category counts == meta', gcObj, meta.categoryCounts);

// === Gremlin groupCount over tag (via out TAGGED) ===
const tgc = toArray(
  traversal(V(), hasLabel('Article'), out('TAGGED'), values('name'), groupCount()),
  g,
);
const tgcObj = tgc[0] instanceof Map ? Object.fromEntries(tgc[0] as Map<string, number>) : tgc[0];
assertEq('gremlin tag counts == meta', tgcObj, meta.tagArticleCounts);

// === Gremlin groupCount over author ===
const agc = toArray(
  traversal(V(), hasLabel('Article'), out('WRITTEN_BY'), values('name'), groupCount()),
  g,
);
const agcObj = agc[0] instanceof Map ? Object.fromEntries(agc[0] as Map<string, number>) : agc[0];
assertEq('gremlin author counts == meta', agcObj, meta.authorArticleCounts);

// === Cross-check: GQL category counts vs Gremlin groupCount ===
const gqlCat = query(g, `MATCH (a:Article) RETURN a.category AS c, count(*) AS n`);
const gqlCatObj = Object.fromEntries(gqlCat.map((r: any) => [r.c, r.n]));
assertEq('GQL category counts == Gremlin groupCount', gqlCatObj, gcObj);

// === Gremlin total Article count vs GQL ===
const gremCount = toArray(traversal(V(), hasLabel('Article'), count()), g)[0];
const gqlCount = query(g, `MATCH (a:Article) RETURN count(*) AS n`)[0].n;
assertEq('Gremlin count == GQL count', gremCount, gqlCount);

// === Text search cross-check: Gremlin containing() predicate vs GQL CONTAINS ===
import { containing } from '@lenke/gremlin';
const gremContain = toArray(
  traversal(V(), hasLabel('Article'), has('body', containing('rust')), count()),
  g,
)[0];
const gqlContain = query(
  g,
  `MATCH (a:Article) WHERE a.body CONTAINS 'rust' RETURN count(*) AS n`,
)[0].n;
assertEq('Gremlin containing() == GQL CONTAINS', gremContain, gqlContain);

// Order-insensitive re-check (counts, not key order).
function sortedEq(a: Record<string, number>, b: Record<string, number>) {
  const norm = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort());
  return norm(a) === norm(b);
}
console.log('\n--- order-insensitive ---');
console.log('category match:', sortedEq(gcObj as any, meta.categoryCounts));
console.log('tag match:', sortedEq(tgcObj as any, meta.tagArticleCounts));
console.log('author match:', sortedEq(agcObj as any, meta.authorArticleCounts));
