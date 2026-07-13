import { query } from '@lenke/gql';

// Ranking: computed relevance score (title match weighted over body), recency,
// plus pagination (SKIP/LIMIT, OFFSET/LIMIT). Verified against plain JS.
import { buildCorpus } from './corpus';

const { g } = buildCorpus();

type Art = { title: string; body: string; published: string; views: number };
const arts: Art[] = [];
for (const v of g.vertices) {
  if (v.labels.has('Article')) {
    arts.push({
      title: v.properties.title as string,
      body: v.properties.body as string,
      published: v.properties.published as string,
      views: v.properties.views as number,
    });
  }
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  console.log(
    `${a === e ? 'OK ' : 'FAIL'} ${label}${a === e ? '' : `\n   actual=${a}\n   expected=${e}`}`,
  );
}

const TERM = 'graph';

// Relevance score: 3 points if title contains term, 1 if body contains term.
// Use CASE expressions to compute it.
const scoreQ = `
  MATCH (a:Article)
  WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t
  RETURN a.title AS title,
         (CASE WHEN lower(a.title) CONTAINS $t THEN 3 ELSE 0 END
          + CASE WHEN lower(a.body) CONTAINS $t THEN 1 ELSE 0 END) AS score
  ORDER BY score DESC, a.title ASC
  LIMIT 10
`;
const gqlRanked = query(g, scoreQ, { t: TERM });

// Independent JS.
const jsScored = arts
  .filter((a) => a.title.toLowerCase().includes(TERM) || a.body.toLowerCase().includes(TERM))
  .map((a) => ({
    title: a.title,
    score:
      (a.title.toLowerCase().includes(TERM) ? 3 : 0) +
      (a.body.toLowerCase().includes(TERM) ? 1 : 0),
  }))
  .sort((x, y) => y.score - x.score || (x.title < y.title ? -1 : x.title > y.title ? 1 : 0))
  .slice(0, 10);
assertEq('ranked top-10 (score desc, title asc)', gqlRanked, jsScored);

// --- Recency ordering (published desc) top 5 ---
const gqlRecent = query(
  g,
  `MATCH (a:Article) RETURN a.title AS title, a.published AS pub ORDER BY a.published DESC, a.title ASC LIMIT 5`,
);
const jsRecent = arts
  .map((a) => ({ title: a.title, pub: a.published }))
  .sort((x, y) =>
    y.pub < x.pub ? -1 : y.pub > x.pub ? 1 : x.title < y.title ? -1 : x.title > y.title ? 1 : 0,
  )
  .slice(0, 5);
assertEq('recency top-5', gqlRecent, jsRecent);

// --- Pagination: SKIP + LIMIT (page 2 of views-desc) ---
const pageSize = 10;
const gqlPage2 = query(
  g,
  `MATCH (a:Article) RETURN a.title AS title, a.views AS views ORDER BY a.views DESC, a.title ASC SKIP ${pageSize} LIMIT ${pageSize}`,
);
const jsAllSorted = arts
  .map((a) => ({ title: a.title, views: a.views }))
  .sort((x, y) => y.views - x.views || (x.title < y.title ? -1 : x.title > y.title ? 1 : 0));
const jsPage2 = jsAllSorted.slice(pageSize, pageSize * 2);
assertEq('SKIP 10 LIMIT 10 (views desc)', gqlPage2, jsPage2);

// --- OFFSET keyword variant ---
const gqlOffset = query(
  g,
  `MATCH (a:Article) RETURN a.title AS title, a.views AS views ORDER BY a.views DESC, a.title ASC OFFSET ${pageSize} LIMIT ${pageSize}`,
);
assertEq('OFFSET == SKIP', gqlOffset, gqlPage2);

// --- ORDER BY a computed alias directly (can we ORDER BY score alias?) ---
try {
  const q = query(
    g,
    `MATCH (a:Article) WHERE lower(a.title) CONTAINS $t
     RETURN a.title AS title, char_length(a.title) AS len ORDER BY len DESC LIMIT 3`,
    { t: TERM },
  );
  console.log('ORDER BY alias OK:', JSON.stringify(q));
} catch (e) {
  console.log('ORDER BY alias FAILED:', (e as Error).message);
}
