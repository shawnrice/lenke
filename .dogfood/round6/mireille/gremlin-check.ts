import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  run,
  toArray,
  traversal,
  V,
  values,
  sum,
  mean,
  min,
  max,
  math,
  fold,
  inject,
} from '@lenke/gremlin';

const ratings = [4.5, 4.1, 3.9, 3.7, 4.2, 4.4, 3.2, 4.6, 4.0, 4.3, 2.8, 3.5, 5.0, 1.9, 3.3];
const g = new Graph();
ratings.forEach((r, i) => g.addVertex({ labels: ['P'], properties: { i, r } }));

const first = <T>(it: Iterable<T>): T | undefined => toArray(traversal(...[]), g) as any;
const rg = <T>(...steps: any[]): T => toArray(traversal(...steps), g)[0] as T;

const jsSum = ratings.reduce((a, b) => a + b, 0);
const jsMean = jsSum / ratings.length;
const jsMin = Math.min(...ratings);
const jsMax = Math.max(...ratings);

const gqlN = (q: string) => (query(g, q)[0] as any)?.r;

console.log('=== GREMLIN vs GQL vs JS numeric aggregates ===');
const grSum = rg<number>(V(), values('r'), sum());
const grMean = rg<number>(V(), values('r'), mean());
const grMin = rg<number>(V(), values('r'), min());
const grMax = rg<number>(V(), values('r'), max());
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
for (const [label, gr, gqlq, js] of [
  ['sum', grSum, 'sum(p.r)', jsSum],
  ['mean/avg', grMean, 'avg(p.r)', jsMean],
  ['min', grMin, 'min(p.r)', jsMin],
  ['max', grMax, 'max(p.r)', jsMax],
] as const) {
  const gq = gqlN(`MATCH (p:P) RETURN ${gqlq} AS r`);
  const ok = near(gr, js) && near(gq, js);
  console.log(`${ok ? 'MATCH' : 'DIFF!'} ${label.padEnd(9)} gremlin=${gr}  gql=${gq}  js=${js}`);
}

console.log('\n=== GREMLIN math() step capability ===');
// arithmetic works:
try {
  const r = rg<number>(inject(10), math('_ / 4'));
  console.log(`math('_ / 4') on 10 => ${r}  (js: ${10 / 4})  ${r === 2.5 ? 'ok' : 'DIFF'}`);
} catch (e: any) {
  console.log(`math('_ / 4') ERR: ${e?.message?.slice(0, 60)}`);
}
// functions do NOT:
for (const expr of ['sqrt(_)', 'sin(_)', '_ ^ 2', 'abs(_)']) {
  try {
    const r = rg<number>(inject(4), math(expr));
    console.log(`math('${expr}') on 4 => ${r}`);
  } catch (e: any) {
    console.log(
      `math('${expr}') => ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 55)}>`,
    );
  }
}
