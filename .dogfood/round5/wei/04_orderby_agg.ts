import { query } from '@lenke/gql';

// Investigate: ORDER BY count(*) directly (aggregate in ORDER BY where the
// RETURN has a non-aggregated grouping key) — does it group correctly?
import { buildCorpus } from './corpus';

const { g, meta } = buildCorpus();

// Baseline: correct grouped counts (aliased), sorted desc.
const correct = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag, count(*) AS n ORDER BY n DESC, t.name ASC`,
);
console.log('CORRECT grouped (alias):', JSON.stringify(correct.slice(0, 6)));
console.log('  row count:', correct.length, '(expected 14 distinct tags)');

// Suspect: ORDER BY count(*) directly, RETURN only the key.
const suspect = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag ORDER BY count(*) DESC`,
);
console.log('\nSUSPECT ORDER BY count(*):', JSON.stringify(suspect.slice(0, 10)));
console.log('  row count:', suspect.length);
// A correct grouped result should have exactly 14 rows (one per tag).

// Also: does adding DISTINCT change it?
const withDistinct = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN DISTINCT t.name AS tag ORDER BY count(*) DESC`,
);
console.log('\nWith DISTINCT:', JSON.stringify(withDistinct.slice(0, 10)));
console.log('  row count:', withDistinct.length);

// What does the same shape do with a plain (non-aggregate) ORDER BY?
const plain = query(
  g,
  `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag ORDER BY t.name ASC`,
);
console.log(
  '\nplain RETURN key ORDER BY key row count:',
  plain.length,
  '(no implicit grouping — one row per edge)',
);

console.log('\nmeta tag counts:', JSON.stringify(meta.tagArticleCounts));
