import { query } from '@lenke/gql';

// Edge cases a real KB search/reporting feature hits: case-folding on non-ASCII,
// group-by on a derived string key, top-N-per-group, DISTINCT counts, empty results.
import { buildCorpus } from './corpus';

const { g } = buildCorpus();

function log(label: string, v: unknown) {
  console.log(`${label}: ${JSON.stringify(v)}`);
}

// === Case folding on non-ASCII (Turkish/German/Greek edge cases) ===
console.log('=== case-folding non-ASCII ===');
log("lower('İSTANBUL')", query(g, `RETURN lower('İSTANBUL') AS r`)[0].r); // Turkish dotted I
console.log('  JS toLowerCase:', 'İSTANBUL'.toLowerCase());
log("upper('straße')", query(g, `RETURN upper('straße') AS r`)[0].r); // German ß -> SS?
console.log('  JS toUpperCase:', 'straße'.toUpperCase());
log("lower('ΣΊΣΥΦΟΣ')", query(g, `RETURN lower('ΣΊΣΥΦΟΣ') AS r`)[0].r); // Greek final sigma
console.log('  JS toLowerCase:', 'ΣΊΣΥΦΟΣ'.toLowerCase());

// === Group-by on a DERIVED key (first letter of title) — needs substring in grouping ===
console.log('\n=== group by derived key (title initial) ===');
try {
  const q = query(
    g,
    `MATCH (a:Article) RETURN upper(substring(a.title, 1, 1)) AS initial, count(*) AS n ORDER BY initial ASC`,
  );
  log('group by title initial', q);
  // Independent JS check
  const counts: Record<string, number> = {};
  for (const v of g.vertices) {
    if (v.labels.has('Article')) {
      const init = (v.properties.title as string).substring(0, 1).toUpperCase();
      counts[init] = (counts[init] ?? 0) + 1;
    }
  }
  const js = Object.entries(counts)
    .map(([initial, n]) => ({ initial, n }))
    .sort((a, b) => (a.initial < b.initial ? -1 : 1));
  console.log('  JS matches:', JSON.stringify(q) === JSON.stringify(js));
} catch (e) {
  console.log('  FAILED:', (e as Error).message);
}

// === DISTINCT count: how many distinct categories? ===
console.log('\n=== distinct counts ===');
// count(DISTINCT x) — is it supported?
try {
  const q = query(g, `MATCH (a:Article) RETURN count(DISTINCT a.category) AS n`);
  log('count(DISTINCT category)', q);
} catch (e) {
  console.log('  count(DISTINCT) FAILED:', (e as Error).message);
}

// === Empty result set aggregate: count over no matches ===
console.log('\n=== empty aggregates ===');
log(
  'count(*) of no matches',
  query(g, `MATCH (a:Article) WHERE a.title = 'NONEXISTENT_ZZZ' RETURN count(*) AS n`),
);
log(
  'sum() of no matches',
  query(
    g,
    `MATCH (a:Article) WHERE a.views < 0 RETURN sum(a.views) AS s, avg(a.views) AS av, max(a.views) AS mx`,
  ),
);

// === Top-N per group (top tag per category) — hard; needs correlated agg ===
console.log('\n=== reporting: articles with 3 tags (list aggregation) ===');
const multiTag = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) WITH a, collect_list(t.name) AS tags WHERE size(tags) = 3 RETURN count(*) AS articlesWith3Tags`,
);
log('articles with exactly 3 tags', multiTag);
// JS check
let three = 0;
const tagsByArt = new Map<string, number>();
for (const e of g.edges) {
  if (e.labels.has('TAGGED')) tagsByArt.set(e.from.id, (tagsByArt.get(e.from.id) ?? 0) + 1);
}
for (const c of tagsByArt.values()) if (c === 3) three++;
console.log('  JS:', three, 'match:', (multiTag[0] as any).articlesWith3Tags === three);
