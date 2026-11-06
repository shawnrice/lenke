/**
 * Before building identity-only element dedup: what does NATIVE answer on every shape where
 * identity and `String(v.id)` disagree? (item 1588)
 *
 * GQL's `valueSet` keys an element by `String(v.id)`, so two values with equal ids are ONE value.
 * Keying by object identity instead would split them. There are exactly two reachable ways for that
 * to differ, both found at item 1584:
 *
 *   1. A numeric id and its string form — `addVertex({id: 5})` and `addVertex({id: '5'})`. TS says
 *      `count(DISTINCT n)` is 1; native says 2. Identity keying would make TS say 2. (Divergence 13.)
 *   2. A VERTEX and an EDGE sharing an id — both key `@x` today, so they collapse.
 *
 * ⚠️ NATIVE IS THE ORACLE, and its answer DECIDES whether this change is a fix or a new divergence.
 * Case 1 is already known (native: 2, so identity keying fixes it). Case 2 is NOT, and if native
 * collapses there while identity keying splits, the change would trade one divergence for another.
 * That is the question this probe exists to answer, and it is cheaper than finding out after
 * building it.
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend } from './src/conformance-harness.ts';
import { graphFromNdjson } from './src/graph.ts';

const compare = (label, ndjson, queries) => {
  console.log(`\n=== ${label} ===`);

  let nat;
  let ts;

  try {
    nat = graphFromNdjson(nativeBackend(), ndjson);
    ts = tsDeserialize(ndjson, 'ndjson', new Graph());
  } catch (e) {
    console.log(`  ingest THREW: ${e.message.slice(0, 120)}`);

    return;
  }

  for (const q of queries) {
    const t = (() => {
      try {
        return JSON.stringify(tsQuery(ts, q));
      } catch (e) {
        return `THREW ${e.message.slice(0, 60)}`;
      }
    })();
    const n = (() => {
      try {
        return JSON.stringify(nat.query(q));
      } catch (e) {
        return `THREW ${e.message.slice(0, 60)}`;
      }
    })();

    console.log(`  ${t === n ? 'AGREE   ' : 'DIVERGE '} ts=${t}  nat=${n}`);
    console.log(`           ${q}`);
  }
};

// CASE 1: a numeric id and its string form. Known: ts 1, nat 2.
compare(
  'numeric id vs string id',
  [
    '{"type":"node","id":5,"labels":["P"],"properties":{"k":1}}',
    '{"type":"node","id":"5","labels":["P"],"properties":{"k":2}}',
  ].join('\n'),
  [
    'MATCH (n:P) RETURN count(*) AS c',
    'MATCH (n:P) RETURN count(DISTINCT n) AS c',
    'MATCH (n:P) RETURN DISTINCT n',
  ],
);

// CASE 2: a VERTEX and an EDGE sharing an id, in ONE dedup via UNION. This is the one that decides
// whether identity keying is safe.
compare(
  'vertex and edge sharing an id',
  [
    '{"type":"node","id":"x","labels":["P"],"properties":{"k":1}}',
    '{"type":"node","id":"y","labels":["P"],"properties":{"k":2}}',
    '{"type":"edge","id":"x","labels":["E"],"from":"x","to":"y","properties":{}}',
  ].join('\n'),
  [
    'MATCH (n:P) WHERE n.k = 1 RETURN DISTINCT n UNION MATCH ()-[e:E]->() RETURN DISTINCT e',
    'MATCH (n:P) WHERE n.k = 1 RETURN count(DISTINCT n) AS c',
    'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c',
  ],
);

// CASE 3: the ordinary case, as a control — distinct ids must stay distinct either way.
compare(
  'distinct ids (the control)',
  [
    '{"type":"node","id":"a","labels":["P"],"properties":{"k":1}}',
    '{"type":"node","id":"b","labels":["P"],"properties":{"k":1}}',
    '{"type":"node","id":"c","labels":["P"],"properties":{"k":2}}',
  ].join('\n'),
  ['MATCH (n:P) RETURN count(DISTINCT n) AS c', 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c'],
);
