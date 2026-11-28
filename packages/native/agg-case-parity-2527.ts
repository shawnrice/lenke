import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';

/*
 * Item 2527: is an aggregate's NAME case-insensitive on both engines?
 *
 * `ast.ts`'s `AGGREGATES` says it "Mirrors the native engine's aggregate table
 * (`crates/lenke-engine/src/gql.rs`)". **That claim is VERIFIED**: both carry the same ELEVEN names
 * (count, sum, min, max, avg, collect_list, collect, stddev_pop, stddev_samp, percentile_cont,
 * percentile_disc), compared entry by entry.
 *
 * But the two store them differently, and that is the question this probe asks. Rust's `agg_fn`
 * matches on `name.to_ascii_uppercase()`, so it accepts ANY case. TS holds a `Set` of LOWERCASE
 * strings. If the TS lookup does not fold case, then `RETURN COUNT(*)` — the SQL-conventional
 * spelling, and the one most of ISO's own grammar is written in — is valid on native and an error
 * here. That is item 2526's shape exactly: the same query, two verdicts.
 *
 * `count(*)` lowercase is the CONTROL: both engines must accept it. If the control disagrees the
 * harness is wrong, which it was four times at 2526.
 */
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
].join('\n');

const tsGraph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });

  return g;
};

const backend = nativeReady ? nativeBackend() : undefined;

const nativeVerdict = (gql: string): string => {
  if (backend === undefined) {
    return 'native unavailable';
  }

  const handle = backend.graphFromNdjson(new TextEncoder().encode(NDJSON));

  try {
    backend.queryJson(handle, gql);

    return 'ACCEPTED';
  } catch (e) {
    return `REJECTED (${String((e as Error)?.message ?? e).slice(0, 38)})`;
  } finally {
    backend.graphFree(handle);
  }
};

const tsVerdict = (gql: string): string => {
  try {
    query(tsGraph(), gql);

    return 'ACCEPTED';
  } catch (e) {
    return `REJECTED (${String((e as Error)?.message ?? e).slice(0, 38)})`;
  }
};

const row = (label: string, gql: string): void => {
  const ts = tsVerdict(gql);
  const nat = nativeVerdict(gql);
  const flag = ts.slice(0, 8) === nat.slice(0, 8) ? '' : '   <== ENGINES DIFFER';
  const cols = [label.padEnd(26), `ts: ${ts.padEnd(44)}`, `native: ${nat.padEnd(44)}`];

  console.log(`  ${cols.join(' ')}${flag}`);
};

console.log('# is an aggregate NAME case-insensitive on both engines?\n');

row('CONTROL count(*)', 'MATCH (n:P) RETURN count(*) AS c');
row('COUNT(*)', 'MATCH (n:P) RETURN COUNT(*) AS c');
row('Count(*)', 'MATCH (n:P) RETURN Count(*) AS c');
row('CONTROL sum(n.n)', 'MATCH (n:P) RETURN sum(n.n) AS s');
row('SUM(n.n)', 'MATCH (n:P) RETURN SUM(n.n) AS s');
row('COLLECT_LIST(n.n)', 'MATCH (n:P) RETURN COLLECT_LIST(n.n) AS s');
row('STDDEV_POP(n.n)', 'MATCH (n:P) RETURN STDDEV_POP(n.n) AS s');
row('CONTROL a MATCH keyword', 'match (n:P) return count(*) AS c');

console.log('\n  The lowercase rows are CONTROLS: if either disagrees, the harness is wrong.');
console.log('  A keyword row is included because GQL keywords ARE case-insensitive — so if');
console.log(
  '  `match`/`return` fold but an aggregate NAME does not, the asymmetry is internal too.',
);
