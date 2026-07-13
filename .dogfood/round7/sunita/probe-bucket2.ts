import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
g.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T10:15:00'), v: 5 } });
const p = (l: string, q: string) => {
  try {
    console.log(l, JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', e.message);
  }
};
p('sub(s,1,13):', `MATCH (r:R) RETURN substring(to_string(r.ts),1,13) AS s`);
p('sub(s,0,13):', `MATCH (r:R) RETURN substring(to_string(r.ts),0,13) AS s`);
p('sub(s,1,10):', `MATCH (r:R) RETURN substring(to_string(r.ts),1,10) AS s`);
p('sub two-arg(s,1):', `MATCH (r:R) RETURN substring(to_string(r.ts),1) AS s`);
p('left maybe:', `MATCH (r:R) RETURN left(to_string(r.ts),13) AS s`);
p('day quoted:', `MATCH (r:R) RETURN substring(to_string(r.ts),1,10) AS \`day\``);
