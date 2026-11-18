/**
 * Profiles the TS side of the grouped-hop-count shape (item 2236). The far-key OPTIONAL form costs ~350 ns
 * per edge contribution where wasm costs ~12; a compiled closure call is ~3 ns and a keyed property read
 * ~1.4x a literal one, so ~350 ns is several times what the work should need. ARM picks what is timed, and
 * the LOAD arm is subtractable because deserializing 200k nodes plus 300k edges is not free.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 200000);
const ARM = process.env.PROF_ARM ?? 'farkey';

const Q = {
  load: null,
  farkey: 'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN b.k AS g, count(*) AS c',
  plain: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.k AS g, count(*) AS c',
}[ARM];

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90},"k":${i % 97}}}`,
  );
  let id = 0;

  for (let d = 0; d < 3; d += 1) {
    for (let i = 0; i < N; i += 2) {
      lines.push(
        `{"type":"edge","id":"o${id++}","labels":["KNOWS"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

for (let r = 0; r < 6; r += 1) {
  const g = deserialize(doc, 'ndjson', new Graph());

  if (Q !== null) {
    const out = query(g, Q);

    if (out.length < 1) {
      throw new Error('no rows');
    }
  }
}
