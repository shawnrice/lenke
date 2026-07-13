import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
g.addVertex({ labels: ['R'], properties: { value: 5, ts: 1 } });
const p = (l: string, q: string) => {
  try {
    console.log(l, 'OK', JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', e.message);
  }
};
p('r.value (bare):', `MATCH (r:R) RETURN r.value AS x`);
p('r.`value` (quoted):', `MATCH (r:R) RETURN r.\`value\` AS x`);
p('avg(r.`value`):', `MATCH (r:R) RETURN avg(r.\`value\`) AS x`);
p('WHERE r.value>0:', `MATCH (r:R) WHERE r.value > 0 RETURN count(r) AS c`);
