// End-to-end KB search + reporting "endpoint" built entirely on @lenke/gql.
// Demonstrates: case-insensitive multi-field search, relevance ranking,
// pagination, and a faceted sidebar (tag/author/category counts) in one flow.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { buildCorpus } from './corpus';

const { g } = buildCorpus();

interface SearchResult {
  results: Array<{ title: string; score: number; published: string; views: number }>;
  page: number;
  pageSize: number;
  total: number;
  facets: {
    tags: Array<{ tag: string; n: number }>;
    authors: Array<{ author: string; n: number }>;
    categories: Array<{ category: string; n: number }>;
  };
}

function search(g: Graph, term: string, page = 0, pageSize = 5): SearchResult {
  const t = term.toLowerCase();
  // SKIP/LIMIT reject $params (see 11_skip_limit_param.ts) — must splice literals.
  // Validate to ints so the interpolation is injection-safe.
  const skip = Math.max(0, Math.trunc(page * pageSize));
  const limit = Math.max(0, Math.trunc(pageSize));

  // Total matches (for pagination UI).
  const total = query(
    g,
    `MATCH (a:Article) WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t RETURN count(*) AS n`,
    { t },
  )[0].n as number;

  // Ranked, paginated results: title match = 3, body match = 1, small recency tiebreak.
  const results = query(
    g,
    `MATCH (a:Article)
     WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t
     RETURN a.title AS title,
            (CASE WHEN lower(a.title) CONTAINS $t THEN 3 ELSE 0 END
             + CASE WHEN lower(a.body) CONTAINS $t THEN 1 ELSE 0 END) AS score,
            a.published AS published,
            a.views AS views
     ORDER BY score DESC, a.published DESC, a.title ASC
     SKIP ${skip} LIMIT ${limit}`,
    { t },
  ) as SearchResult['results'];

  // Faceted sidebar over the matched set.
  const tags = query(
    g,
    `MATCH (a:Article)-[:TAGGED]->(tag:Tag)
     WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t
     RETURN tag.name AS tag, count(*) AS n ORDER BY n DESC, tag.name ASC LIMIT 5`,
    { t },
  ) as SearchResult['facets']['tags'];

  const authors = query(
    g,
    `MATCH (a:Article)-[:WRITTEN_BY]->(au:Author)
     WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t
     RETURN au.name AS author, count(*) AS n ORDER BY n DESC, au.name ASC LIMIT 5`,
    { t },
  ) as SearchResult['facets']['authors'];

  const categories = query(
    g,
    `MATCH (a:Article)
     WHERE lower(a.title) CONTAINS $t OR lower(a.body) CONTAINS $t
     RETURN a.category AS category, count(*) AS n ORDER BY n DESC, a.category ASC`,
    { t },
  ) as SearchResult['facets']['categories'];

  return { results, page, pageSize, total, facets: { tags, authors, categories } };
}

const res = search(g, 'graph', 0, 5);
console.log('=== KB search: "graph" (page 0) ===');
console.log('total matches:', res.total);
console.log('page results:');
for (const r of res.results)
  console.log(`  [${r.score}] ${r.title}  (${r.published}, ${r.views} views)`);
console.log('facet tags:', JSON.stringify(res.facets.tags));
console.log('facet authors:', JSON.stringify(res.facets.authors));
console.log('facet categories:', JSON.stringify(res.facets.categories));

// Independent verification of total + facet-category-sum == total.
const facetCatSum = res.facets.categories.reduce((s, c) => s + c.n, 0);
console.log(
  '\nfacet category counts sum to total:',
  facetCatSum === res.total,
  `(${facetCatSum} vs ${res.total})`,
);

// Page 1 should be disjoint from page 0.
const p1 = search(g, 'graph', 1, 5);
const overlap = res.results.filter((r) =>
  p1.results.some((x) => x.title === r.title && x.published === r.published),
);
console.log('page 0/1 title overlap (dup risk):', overlap.length);
