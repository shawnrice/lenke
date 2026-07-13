import { query } from '@lenke/gql';

// Faceted counts / reporting via GQL implicit grouping. Every facet verified
// against the corpus meta (independent JS counts computed during generation).
import { buildCorpus } from './corpus';

const { g, meta } = buildCorpus();

function assertEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  console.log(
    `${a === e ? 'OK ' : 'FAIL'} ${label}${a === e ? '' : `\n   actual=${a}\n   expected=${e}`}`,
  );
}

// === 1. Counts per category (implicit GROUP BY the non-aggregated key) ===
const catQ = query(
  g,
  `MATCH (a:Article) RETURN a.category AS category, count(*) AS n ORDER BY a.category ASC`,
);
const jsCat = Object.entries(meta.categoryCounts)
  .map(([category, n]) => ({ category, n }))
  .sort((x, y) => (x.category < y.category ? -1 : 1));
assertEq('counts per category', catQ, jsCat);

// === 2. Counts per author (via edge traversal) ===
const authQ = query(
  g,
  `MATCH (a:Article)-[:WRITTEN_BY]->(au:Author) RETURN au.name AS author, count(*) AS n ORDER BY au.name ASC`,
);
const jsAuth = Object.entries(meta.authorArticleCounts)
  .map(([author, n]) => ({ author, n }))
  .sort((x, y) => (x.author < y.author ? -1 : 1));
assertEq('counts per author', authQ, jsAuth);

// === 3. Counts per tag ===
const tagQ = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag, count(*) AS n ORDER BY t.name ASC`,
);
const jsTag = Object.entries(meta.tagArticleCounts)
  .map(([tag, n]) => ({ tag, n }))
  .sort((x, y) => (x.tag < y.tag ? -1 : 1));
assertEq('counts per tag', tagQ, jsTag);

// === 4. Top-N tags — ORDER BY count DESC (the "can't ORDER BY count?" test) ===
// Alias 'count' is reserved; use `AS n` and ORDER BY n.
const topTagsQ = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag, count(*) AS n ORDER BY n DESC, t.name ASC LIMIT 5`,
);
const jsTopTags = Object.entries(meta.tagArticleCounts)
  .map(([tag, n]) => ({ tag, n }))
  .sort((x, y) => y.n - x.n || (x.tag < y.tag ? -1 : 1))
  .slice(0, 5);
assertEq('top-5 tags by count desc', topTagsQ, jsTopTags);

// === 5. Can we ORDER BY count(*) directly (aggregate in ORDER BY, not aliased)? ===
try {
  const q = query(
    g,
    `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag ORDER BY count(*) DESC LIMIT 3`,
  );
  console.log('ORDER BY count(*) direct OK:', JSON.stringify(q));
} catch (e) {
  console.log('ORDER BY count(*) direct FAILED:', (e as Error).message);
}

// === 6. Articles-per-author histogram: how many authors have k articles? ===
// Two-level aggregation: first count per author, then group by that count.
// GQL has no subquery-in-FROM; try WITH chaining.
try {
  const q = query(
    g,
    `MATCH (a:Article)-[:WRITTEN_BY]->(au:Author)
     WITH au, count(*) AS c
     RETURN c AS articles, count(*) AS authors ORDER BY c ASC`,
  );
  // JS: bucket author counts.
  const buckets: Record<number, number> = {};
  for (const c of Object.values(meta.authorArticleCounts)) buckets[c] = (buckets[c] ?? 0) + 1;
  const jsHist = Object.entries(buckets)
    .map(([articles, authors]) => ({ articles: Number(articles), authors }))
    .sort((x, y) => x.articles - y.articles);
  assertEq('articles-per-author histogram (WITH re-aggregation)', q, jsHist);
} catch (e) {
  console.log('histogram FAILED:', (e as Error).message);
}

// === 7. avg / sum / min / max of views per category ===
const statsQ = query(
  g,
  `MATCH (a:Article) RETURN a.category AS cat, count(*) AS n, sum(a.views) AS total, min(a.views) AS lo, max(a.views) AS hi ORDER BY a.category ASC`,
);
// JS independent.
const byCat: Record<string, number[]> = {};
for (const v of g.vertices) {
  if (v.labels.has('Article')) {
    const c = v.properties.category as string;
    (byCat[c] ??= []).push(v.properties.views as number);
  }
}
const jsStats = Object.keys(byCat)
  .sort()
  .map((cat) => ({
    cat,
    n: byCat[cat].length,
    total: byCat[cat].reduce((s, x) => s + x, 0),
    lo: Math.min(...byCat[cat]),
    hi: Math.max(...byCat[cat]),
  }));
assertEq('per-category count/sum/min/max views', statsQ, jsStats);

// === 8. avg (float) check ===
const avgQ = query(g, `MATCH (a:Article) RETURN avg(a.views) AS mean`)[0].mean as number;
const allViews: number[] = [];
for (const v of g.vertices)
  if (v.labels.has('Article')) allViews.push(v.properties.views as number);
const jsAvg = allViews.reduce((s, x) => s + x, 0) / allViews.length;
console.log(`${Math.abs(avgQ - jsAvg) < 1e-9 ? 'OK ' : 'FAIL'} avg(views) gql=${avgQ} js=${jsAvg}`);

// === 9. collect_list per author (list of titles) length check ===
const collectQ = query(
  g,
  `MATCH (a:Article)-[:WRITTEN_BY]->(au:Author) RETURN au.name AS author, size(collect_list(a.title)) AS titles ORDER BY au.name ASC`,
);
assertEq(
  'collect_list size per author == count',
  collectQ,
  jsAuth.map((x) => ({ author: x.author, titles: x.n })),
);

// === 10. Grand total with no grouping key (pure aggregate) ===
const grand = query(g, `MATCH (a:Article) RETURN count(*) AS n, sum(a.views) AS total`);
assertEq('grand total row count', grand.length, 1);
