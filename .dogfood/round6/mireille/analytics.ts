import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

// number-typed ratings so aggregates behave
const ratings = [4.5, 4.1, 3.9, 3.7, 4.2, 4.4, 3.2, 4.6, 4.0, 4.3, 2.8, 3.5, 5.0, 1.9, 3.3];
const g = new Graph();
ratings.forEach((r, i) => g.addVertex({ labels: ['P'], properties: { i, r } }));

const one = (q: string, p?: any) => (query(g, q, p)[0] as any)?.r;
const approx = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));

// ---- basic aggregates vs JS ----
const n = ratings.length;
const sum = ratings.reduce((a, b) => a + b, 0);
const mean = sum / n;
const jsMin = Math.min(...ratings);
const jsMax = Math.max(...ratings);
console.log('=== BASIC AGGREGATES vs JS ===');
for (const [q, js] of [
  ['sum(p.r)', sum],
  ['avg(p.r)', mean],
  ['min(p.r)', jsMin],
  ['max(p.r)', jsMax],
  ['count(p.r)', n],
] as const) {
  const got = one(`MATCH (p:P) RETURN ${q} AS r`);
  console.log(`${approx(got, js) ? 'EXACT' : 'DIFF!'}  ${q.padEnd(14)} gql=${got}  js=${js}`);
}

// ---- STDDEV: no aggregate exists. Workaround: sum of squares in one pass. ----
// population variance = sum(r^2)/n - mean^2 ; stddev = sqrt(that)
const sumSq = one(`MATCH (p:P) RETURN sum(power(p.r, 2)) AS r`);
const cnt = one(`MATCH (p:P) RETURN count(p.r) AS r`);
const gqlMean = one(`MATCH (p:P) RETURN avg(p.r) AS r`);
const gqlVarPop = sumSq / cnt - gqlMean * gqlMean;
const gqlStd = Math.sqrt(gqlVarPop);
const jsVarPop = ratings.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
const jsStd = Math.sqrt(jsVarPop);
console.log('\n=== STDDEV (workaround: sum(power(r,2)) two-pass) vs JS ===');
console.log(
  `gql varPop=${gqlVarPop}  js varPop=${jsVarPop}  ${approx(gqlVarPop, jsVarPop) ? 'MATCH' : 'DIFF (catastrophic cancellation?)'}`,
);
console.log(
  `gql stddev=${gqlStd}  js stddev=${jsStd}  ${approx(gqlStd, jsStd) ? 'MATCH' : 'DIFF'}`,
);
// sample variance (n-1)
const gqlVarSamp = (sumSq - cnt * gqlMean * gqlMean) / (cnt - 1);
const jsVarSamp = ratings.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
console.log(
  `gql varSamp=${gqlVarSamp}  js varSamp=${jsVarSamp}  ${approx(gqlVarSamp, jsVarSamp) ? 'MATCH' : 'DIFF'}`,
);

// ---- PERCENTILE / MEDIAN: no aggregate. Workaround: collect_list + list_sort + index ----
// but list[i] indexing is unsupported! So we can sort but cannot pull the k-th element in-query.
const sorted = one(`MATCH (p:P) RETURN list_sort(collect_list(p.r)) AS r`);
console.log('\n=== PERCENTILE workaround attempt ===');
console.log('list_sort(collect_list(r)) =>', JSON.stringify(sorted));
// Try to index it in-query (known unsupported):
try {
  const med = one(`MATCH (p:P) WITH list_sort(collect_list(p.r)) AS s RETURN s[7] AS r`);
  console.log('s[7] median in-query =>', med);
} catch (e: any) {
  console.log('s[7] in-query =>', `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 50)}>`);
}
// head() gets min, but no way to get k-th → percentile must be computed in JS.
const jsSorted = [...ratings].sort((a, b) => a - b);
const jsMedian = jsSorted[Math.floor(n / 2)];
console.log(
  `head(sorted) = ${one(`MATCH (p:P) RETURN head(list_sort(collect_list(p.r))) AS r`)} (min)`,
);
console.log(
  `last(sorted) = ${one(`MATCH (p:P) RETURN last(list_sort(collect_list(p.r))) AS r`)} (max)`,
);
console.log(`median must be done in JS: ${jsMedian}`);
console.log(`gql sorted matches js sorted: ${JSON.stringify(sorted) === JSON.stringify(jsSorted)}`);

// ---- HISTOGRAM / bucketing via CASE + group aggregate ----
console.log('\n=== HISTOGRAM via CASE (star-rating buckets) vs JS ===');
const hist = query(
  g,
  `MATCH (p:P)
   WITH CASE
     WHEN p.r < 2 THEN '1'
     WHEN p.r < 3 THEN '2'
     WHEN p.r < 4 THEN '3'
     WHEN p.r < 5 THEN '4'
     ELSE '5' END AS bucket
   RETURN bucket AS r, count(*) AS c
   ORDER BY bucket`,
) as Array<{ r: string; c: number }>;
const jsHist: Record<string, number> = {};
for (const x of ratings) {
  const b = x < 2 ? '1' : x < 3 ? '2' : x < 4 ? '3' : x < 5 ? '4' : '5';
  jsHist[b] = (jsHist[b] ?? 0) + 1;
}
console.log('gql:', JSON.stringify(hist));
console.log('js :', JSON.stringify(jsHist));
const histMatch =
  hist.every((row) => jsHist[row.r] === row.c) && Object.keys(jsHist).length === hist.length;
console.log(`histogram ${histMatch ? 'MATCH' : 'DIFF'}`);

// ---- min-max normalization in-query ----
console.log('\n=== MIN-MAX NORMALIZATION (needs subquery for global min/max) ===');
try {
  const norm = query(
    g,
    `MATCH (p:P)
     WITH min(p.r) AS lo, max(p.r) AS hi
     MATCH (q:P)
     RETURN q.i AS r, (q.r - lo) / (hi - lo) AS norm
     ORDER BY q.i LIMIT 3`,
  );
  console.log('normalized (first 3):', JSON.stringify(norm));
  const lo = jsMin,
    hi = jsMax;
  console.log(
    'js expected:',
    ratings.slice(0, 3).map((r, i) => ({ r: i, norm: (r - lo) / (hi - lo) })),
  );
} catch (e: any) {
  console.log('normalization ERR:', `${e?.code ?? e?.name}: ${String(e?.message).slice(0, 60)}`);
}
