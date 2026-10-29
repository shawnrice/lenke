/**
 * Does the TS engine KEEP the null that the Rust engine drops from `collect`? (item 1195)
 *
 * Found while giving item 1195's egress gate its teeth: `MATCH (a:N) RETURN collect(a.s)` over
 * three nodes where the middle one has no `s` returns `[Str("a"), Str("c")]` in Rust — the absent
 * cell is GONE. That contradicts `AggFn::Collect`'s own doc comment ("Nulls are kept — this is a
 * faithful fold of the stream, not a null-skipping numeric aggregate"), and it is what makes
 * `Collect` a distinct variant from `CollectList` in the first place.
 *
 * It is NOT caused by item 1195 — the pre-change binary drops it identically — so the only
 * question that matters is which engine is right, and byte-identity makes that the TS engine's
 * vote. If TS keeps the null, this is a cross-engine divergence the seven fuzzers do not cover.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const g = new TsGraph();
g.addVertex({ id: 'n0', labels: ['N'], properties: { n: 1, s: 'a' } });
g.addVertex({ id: 'n1', labels: ['N'], properties: { n: 2 } }); // no `s` — the absent cell
g.addVertex({ id: 'n2', labels: ['N'], properties: { n: 3, s: 'c' } });

for (const q of [
  'MATCH (a:N) RETURN collect(a.s) AS c',
  'MATCH (a:N) RETURN collect_list(a.s) AS c',
  'MATCH (a:N) RETURN collect(a.n) AS c',
]) {
  let out: string;

  try {
    out = JSON.stringify(tsQuery(g, q));
  } catch (e) {
    out = `THREW ${(e as Error).message}`;
  }

  console.log(`  ${q.padEnd(46)} ${out}`);
}

console.log(
  '\n  Rust for the first row: [List([Str("a"), Str("c")])] — the null is DROPPED.\n' +
    '  If TS shows three cells with a null, collect diverges across the engines.',
);
