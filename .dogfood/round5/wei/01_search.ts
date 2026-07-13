import { query } from '@lenke/gql';

// Text search: CONTAINS / STARTS WITH / ENDS WITH, case-insensitive, multi-term.
// Each GQL result is cross-checked against an independent plain-JS computation.
import { buildCorpus } from './corpus';

const { g } = buildCorpus();

// Collect articles into plain JS for independent verification.
type Art = {
  id: string;
  title: string;
  body: string;
  category: string;
  published: string;
  views: number;
};
const arts: Art[] = [];
for (const v of g.vertices) {
  if (v.labels.has('Article')) {
    arts.push({
      id: v.id,
      title: v.properties.title as string,
      body: v.properties.body as string,
      category: v.properties.category as string,
      published: v.properties.published as string,
      views: v.properties.views as number,
    });
  }
}
console.log('total articles', arts.length);

function assertEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? 'OK ' : 'FAIL'} ${label}${ok ? '' : `\n   actual=${a}\n   expected=${e}`}`);
}

// --- 1. CONTAINS (case sensitive) on body for 'rust' ---
const gqlContains = query(
  g,
  `MATCH (a:Article) WHERE a.body CONTAINS 'rust' RETURN count(*) AS n`,
)[0].n;
const jsContains = arts.filter((a) => a.body.includes('rust')).length;
assertEq("body CONTAINS 'rust' count", gqlContains, jsContains);

// --- 2. Case-insensitive search via lower() ---
const term = 'GRAPH';
const gqlCI = query(
  g,
  `MATCH (a:Article) WHERE lower(a.title) CONTAINS lower($t) RETURN count(*) AS n`,
  {
    t: term,
  },
)[0].n;
const jsCI = arts.filter((a) => a.title.toLowerCase().includes(term.toLowerCase())).length;
assertEq("case-insensitive title CONTAINS 'graph'", gqlCI, jsCI);

// --- 3. STARTS WITH on title ---
const gqlSW = query(
  g,
  `MATCH (a:Article) WHERE a.title STARTS WITH 'Scaling' RETURN count(*) AS n`,
)[0].n;
const jsSW = arts.filter((a) => a.title.startsWith('Scaling')).length;
assertEq("title STARTS WITH 'Scaling'", gqlSW, jsSW);

// --- 4. ENDS WITH on body ---
const gqlEW = query(g, `MATCH (a:Article) WHERE a.body ENDS WITH 'memory' RETURN count(*) AS n`)[0]
  .n;
const jsEW = arts.filter((a) => a.body.endsWith('memory')).length;
assertEq("body ENDS WITH 'memory'", gqlEW, jsEW);

// --- 5. Multi-term AND: title contains 'graph' AND body contains 'index' ---
const gqlMulti = query(
  g,
  `MATCH (a:Article) WHERE lower(a.title) CONTAINS 'graph' AND lower(a.body) CONTAINS 'index' RETURN count(*) AS n`,
)[0].n;
const jsMulti = arts.filter(
  (a) => a.title.toLowerCase().includes('graph') && a.body.toLowerCase().includes('index'),
).length;
assertEq('multi-term AND count', gqlMulti, jsMulti);

// --- 6. Multi-term OR ---
const gqlOr = query(
  g,
  `MATCH (a:Article) WHERE a.body CONTAINS 'rust' OR a.body CONTAINS 'typescript' RETURN count(*) AS n`,
)[0].n;
const jsOr = arts.filter((a) => a.body.includes('rust') || a.body.includes('typescript')).length;
assertEq('multi-term OR count', gqlOr, jsOr);

// --- 7. upper() sanity ---
const gqlUpper = query(g, `MATCH (a:Article {title: 'Goodbye'}) RETURN upper('goodbye') AS u`);
assertEq('upper() literal', query(g, `RETURN upper('café') AS u`)[0].u, 'CAFÉ');

// --- 8. lower() on CJK / mixed (should be identity for CJK) ---
assertEq(
  'lower CJK identity',
  query(g, `RETURN lower('数据库') AS u`)[0].u,
  '数据库'.toLowerCase(),
);

// --- 9. contains() function form returns 1/0? boolean? ---
console.log('contains() fn form:', query(g, `RETURN contains('hello world', 'world') AS c`));
console.log('starts_with() fn form:', query(g, `RETURN starts_with('hello', 'he') AS c`));
