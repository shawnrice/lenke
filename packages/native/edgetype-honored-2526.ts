import { nativeBackend, nativeReady } from './src/conformance-harness.js';

/*
 * Item 2526, second half: native ACCEPTS `CALL degree({edgeType: 'E'})` where TS rejects it. The
 * question that decides who is wrong is not whether native accepts it but whether native HONORS it.
 *
 * Both engines' own comments say config validation exists "so a typo or a wrong key no longer
 * silently no-ops". So:
 *
 *   - if `edgeType` behaves like `edgeLabel`, native honors it and TS is missing an alias for the
 *     host API's own vocabulary (`edgeType` appears 124 times in `Graph.ts`);
 *   - if `edgeType` behaves like NO CONFIG, native accepts a key it ignores — the silent no-op both
 *     engines claim to have removed, and TS's rejection is then the SAFER behaviour.
 *
 * THE FIXTURE FORCES THE DISTINCTION (item 2521's rule): vertex `a` has ONE `E` edge and TWO `F`
 * edges, so the three answers are all different — filtered to E gives 1, filtered to F gives 2, and
 * unfiltered gives 3. A config that is ignored cannot hide behind a coincidence.
 */
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{}}',
  '{"type":"node","id":"d","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","from":"a","to":"b","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"f1","from":"a","to":"c","labels":["F"],"properties":{}}',
  '{"type":"edge","id":"f2","from":"a","to":"d","labels":["F"],"properties":{}}',
].join('\n');

if (!nativeReady) {
  console.log('native unavailable — this half cannot run here');
} else {
  const backend = nativeBackend();

  const degreeOfA = (config: string): string => {
    const handle = backend.graphFromNdjson(new TextEncoder().encode(NDJSON));

    try {
      const gql = `CALL degree(${config}) YIELD node, degree RETURN max(degree) AS d`;
      const out = backend.queryJson(handle, gql);

      return JSON.stringify(out).slice(0, 48);
    } catch (e) {
      return `THREW ${String((e as Error)?.message ?? e).slice(0, 40)}`;
    } finally {
      backend.graphFree(handle);
    }
  };

  console.log("# native: a has 1 'E' edge and 2 'F' edges, so each answer is distinct\n");

  const rows: [string, string][] = [
    ['no config          (expect 3)', ''],
    ["edgeLabel: 'E'     (expect 1)", "{edgeLabel: 'E'}"],
    ["edgeLabel: 'F'     (expect 2)", "{edgeLabel: 'F'}"],
    ["edgeType:  'E'     -> ?", "{edgeType: 'E'}"],
    ["edgeType:  'F'     -> ?", "{edgeType: 'F'}"],
  ];

  for (const [label, config] of rows) {
    const cols = [label.padEnd(32), degreeOfA(config)];

    console.log(`  ${cols.join(' ')}`);
  }

  console.log('\n  edgeType matching edgeLabel => native HONORS it, and TS is missing an alias.');
  console.log(
    '  edgeType matching NO CONFIG  => native accepts a key it IGNORES (a silent no-op),',
  );
  console.log('  and TS rejecting it is the safer behaviour of the two.');
}
