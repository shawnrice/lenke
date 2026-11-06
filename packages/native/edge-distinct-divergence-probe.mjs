// Is `count(DISTINCT <edge>)` disagreeing because of item 1584, or was it already? (item 1584)
//
// The parity test reads ts 5 against native 3 for five distinct edges. Item 1584 only changed how
// TS KEYS an element in a dedup set, from `'@' + String(v.id)` to `String(v.id)` in a container of
// its own, which cannot change how many distinct ids there are. But "cannot" is the word that
// wants a measurement, so this prints the comparison and is run against BOTH builds.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend } from './src/conformance-harness.ts';
import { graphFromNdjson } from './src/graph.ts';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":1,"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":2,"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"k":1,"n":3}}',
  '{"type":"node","id":"4","labels":["Q"],"properties":{"k":3,"n":4}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"3","to":"2"}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"1","to":"3"}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"2","to":"4"}',
  '{"type":"edge","id":"e5","labels":["E"],"from":"3","to":"3"}',
].join('\n');

const nat = graphFromNdjson(nativeBackend(), NDJSON);
const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

for (const q of [
  // The failing pair. Five edges, five distinct ids.
  'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c',
  // The rows spelling of it, which agreed — so the disagreement is in the COUNT, not the dedup.
  'MATCH ()-[e:E]->() RETURN DISTINCT e',
  // A plain count of the same match, to see whether the MATCH itself finds five.
  'MATCH ()-[e:E]->() RETURN count(*) AS c',
  // Named ends, in case the anonymous ones are what differ.
  'MATCH (x)-[e:E]->(y) RETURN count(DISTINCT e) AS c',
  'MATCH (x)-[e:E]->(y) RETURN count(*) AS c',
  // And an edge property, to separate "counts edges wrong" from "dedups elements wrong".
  'MATCH ()-[e:E]->() RETURN count(DISTINCT e.id) AS c',
  // The unaliased-list column name, the other failure.
  'MATCH (a:P)-[:E]->(b) RETURN DISTINCT [a, b]',
  'MATCH (a:P)-[:E]->(b) RETURN DISTINCT [a, b] AS x',
]) {
  const t = JSON.stringify(tsQuery(ts, q));
  let n;

  try {
    n = JSON.stringify(nat.query(q));
  } catch (e) {
    n = `THREW ${e.message}`;
  }

  console.log(`${t === n ? 'AGREE   ' : 'DIVERGE '} ts=${t}\n         nat=${n}\n         ${q}\n`);
}
