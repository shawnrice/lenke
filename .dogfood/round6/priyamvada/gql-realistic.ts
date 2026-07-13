import { runBoth } from './harness.ts';

// Realistic queries that might silently diverge (not just error-vs-error).
const qs: string[] = [
  // number edge cases
  `RETURN 1e400 AS x`,
  `RETURN -1e400 AS x`,
  `RETURN 0.1+0.2 AS x`,
  `RETURN 1e400 - 1e400 AS x`,
  `RETURN 1/3 AS x`,
  `RETURN 10/3 AS x`,
  `RETURN 2147483647 + 1 AS x`,
  `RETURN 9007199254740993 AS x`,
  `RETURN toInteger(2.9) AS x`,
  `RETURN round(2.5) AS x`,
  `RETURN round(3.5) AS x`,
  `RETURN round(-2.5) AS x`,
  `RETURN floor(-0.0) AS x`,
  `RETURN ceil(-0.5) AS x`,
  `RETURN sign(-0.0) AS x`,
  // string / collation
  `MATCH (n:Person) RETURN n.name ORDER BY n.name DESC`,
  `RETURN 'Z' < 'a' AS x`,
  `RETURN 'a' < 'ä' AS x`,
  `RETURN 'ﬀ' = 'ff' AS x`,
  `RETURN 'abc' STARTS WITH 'a' AS x`,
  `RETURN 'ABC' CONTAINS 'b' AS x`,
  // aggregates
  `MATCH (n:Person) RETURN avg(n.age) AS x`,
  `MATCH (n:Person) RETURN sum(n.age) AS x`,
  `MATCH (n:Person) RETURN min(n.name) AS x`,
  `MATCH (n:Person) RETURN max(n.name) AS x`,
  `MATCH (n) RETURN count(n.age) AS x`,
  `MATCH (n) RETURN count(DISTINCT n.lang) AS x`,
  `MATCH (n:Person) RETURN collect(n.age) AS x`,
  `MATCH (n:Person) RETURN collect(DISTINCT n.age) AS x`,
  `MATCH (n:Person) RETURN stdev(n.age) AS x`,
  `MATCH (n:Person) RETURN percentileCont(n.age, 0.5) AS x`,
  // null handling in agg
  `MATCH (n) RETURN avg(n.age) AS x`,
  `MATCH (n) RETURN sum(n.weight) AS x`,
  // list ops
  `RETURN [1,2,3][1] AS x`,
  `RETURN [1,2,3][-1] AS x`,
  `RETURN [1,2,3][10] AS x`,
  `RETURN size([1,2,3]) AS x`,
  `RETURN reverse([1,2,3]) AS x`,
  `RETURN [1,2,3] + [4] AS x`,
  `RETURN range(1,5) AS x`,
  `RETURN range(5,1,-1) AS x`,
  `RETURN range(1,10,0) AS x`,
  `RETURN head([]) AS x`,
  `RETURN last([]) AS x`,
  `RETURN [x IN [1,2,3] WHERE x>1] AS y`,
  // boolean / null 3-valued
  `RETURN true AND null AS x`,
  `RETURN false AND null AS x`,
  `RETURN null = null AS x`,
  `RETURN 1 IN [1,2,null] AS x`,
  `RETURN 3 IN [1,2,null] AS x`,
  `RETURN null IN [1,2] AS x`,
  // properties on missing
  `MATCH (n:Person) RETURN n.nonexistent AS x`,
  `MATCH (n) RETURN n.age AS x ORDER BY n.age`,
  // DISTINCT / ordering stability
  `MATCH (n) RETURN DISTINCT labels(n) AS x ORDER BY x`,
  `MATCH (n)-[r]->(m) RETURN type(r) AS t ORDER BY t`,
  // WHERE with type coercion
  `MATCH (n) WHERE n.age > '30' RETURN n.name`,
  `MATCH (n) WHERE n.age = 29 RETURN n.name`,
  // arithmetic on temporal
  `RETURN date('2020-01-01') + duration('P1D') AS x`,
  `RETURN date('2020-03-01') - date('2020-01-01') AS x`,
  `RETURN duration('PT1H') / 2 AS x`,
  `RETURN duration('P1M') AS x`,
  // string funcs
  `RETURN split('a,b,c', ',') AS x`,
  `RETURN split('a', '') AS x`,
  `RETURN split('', ',') AS x`,
  `RETURN replace('aaa','a','bb') AS x`,
  `RETURN toString(1.0) AS x`,
  `RETURN toString(true) AS x`,
  `RETURN toString(0.1) AS x`,
  `RETURN toFloat('  1.5  ') AS x`,
  `RETURN toInteger('0x1F') AS x`,
  `RETURN toString(1e100) AS x`,
  `RETURN toString(-0.0) AS x`,
  `RETURN toString(1/3) AS x`,
];

const S = (x: unknown) => {
  try {
    return JSON.stringify(x);
  } catch (e) {
    return `<<${e}>>`;
  }
};
let match = 0;
const finds: string[] = [];
for (const q of qs) {
  const d = runBoth(q);
  if (d.status === 'match') {
    match++;
    continue;
  }
  if (d.status === 'both-error') {
    if (!d.sameCode || d.tsCode.startsWith('UNCODED') || d.nativeCode.startsWith('UNCODED'))
      finds.push(`[ERR-DIFF] ${q} :: ts=${d.tsCode} native=${d.nativeCode}`);
    else match++;
    continue;
  }
  finds.push(
    `[DIVERGENCE] ${q}\n    ts=${S(d.ts).slice(0, 180)}\n    native=${S(d.native).slice(0, 180)}`,
  );
}
console.log(`\n=== GQL REALISTIC: ${qs.length} | match=${match} | findings=${finds.length} ===\n`);
for (const f of finds) console.log(f);
