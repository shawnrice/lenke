import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';

/*
 * Item 2526: does `CALL <proc>({…})` accept the SAME config keys on both engines?
 *
 * Two documented claims led here, one of which checks out and one of which looks asymmetric.
 *
 * VERIFIED BY READING: `clauses.ts`'s `PROCEDURES` says it "Mirrors native
 * `algo::procedure_result_col`, which answers the same question for the same names". It does — both
 * carry the same 12 names with identical result columns, compared entry by entry.
 *
 * THE ASYMMETRY: the crate's `CONFIG_KEYS` comment reads "the TS engine's list, PLUS the engine's
 * `edgeType` spelling of `edgeLabel`", and `clauses.ts` contains the literal `edgeType` ZERO times.
 * Both engines validate config maps and reject unknown keys deliberately ("so a typo or a wrong key
 * no longer silently no-ops"), so if one accepts a key the other refuses, the SAME QUERY is valid on
 * one engine and an error on the other.
 *
 * `edgeLabel` is the CONTROL: it is on both lists, so both engines must accept it. A run where the
 * control disagrees means the harness is wrong, not the engines.
 *
 * Rows print accepted/rejected per engine. A row where the two differ is the finding.
 */
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"edge","id":"e1","from":"a","to":"b","labels":["E"],"properties":{}}',
].join('\n');

const tsGraph = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

  return g;
};

const verdict = (fn: () => unknown): string => {
  try {
    fn();

    return 'ACCEPTED';
  } catch (e) {
    return `REJECTED (${String((e as Error)?.message ?? e).slice(0, 44)})`;
  }
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
    return `REJECTED (${String((e as Error)?.message ?? e).slice(0, 44)})`;
  } finally {
    backend.graphFree(handle);
  }
};

const row = (label: string, gql: string): void => {
  const ts = verdict(() => query(tsGraph(), gql));
  const nat = nativeVerdict(gql);
  const flag = ts.slice(0, 8) === nat.slice(0, 8) ? '' : '   <== ENGINES DIFFER';
  const cols = [label.padEnd(30), `ts: ${ts.padEnd(46)}`, `native: ${nat.padEnd(46)}`];

  console.log(`  ${cols.join(' ')}${flag}`);
};

console.log('# CALL config keys: does each engine accept the same set?\n');

row('CONTROL edgeLabel', "CALL degree({edgeLabel: 'E'}) YIELD node, degree RETURN count(*) AS c");
row('edgeType', "CALL degree({edgeType: 'E'}) YIELD node, degree RETURN count(*) AS c");
row('CONTROL no config', 'CALL degree() YIELD node, degree RETURN count(*) AS c');
row('a genuine typo', "CALL degree({edgeLable: 'E'}) YIELD node, degree RETURN count(*) AS c");
row('CONTROL direction', "CALL degree({direction: 'out'}) YIELD node, degree RETURN count(*) AS c");

console.log(
  '\n  edgeLabel / no-config / direction are CONTROLS: if they disagree, the harness is wrong.',
);
console.log(
  '  A genuine typo SHOULD be rejected by both — that is the behaviour both engines claim.',
);
