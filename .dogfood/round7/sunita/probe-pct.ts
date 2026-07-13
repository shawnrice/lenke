import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) g.addVertex({ labels: ['R'], properties: { v } });
const p = (l: string, q: string) => {
  try {
    console.log(l, 'OK', JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', (e.message || '').split('\n')[0]);
  }
};
p('percentile_cont:', `MATCH (r:R) RETURN percentile_cont(r.v, 0.5) AS x`);
p('percentile_disc:', `MATCH (r:R) RETURN percentile_disc(r.v, 0.5) AS x`);
p('median:', `MATCH (r:R) RETURN median(r.v) AS x`);
p('stddev:', `MATCH (r:R) RETURN stddev(r.v) AS x`);
p('stdev:', `MATCH (r:R) RETURN stdev(r.v) AS x`);
// list index (known gap) for manual median
p('list index s[5]:', `MATCH (r:R) WITH list_sort(collect_list(r.v)) AS s RETURN s[5] AS x`);
