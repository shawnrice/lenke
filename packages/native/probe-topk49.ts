// `ORDER BY <alias> LIMIT n` is rewritten to the alias's expression so the top-k can keep
// INPUT bindings and project only the survivors (`orderNeedsOutput`). The rewrite only
// handles "a plain column of an input variable", so a COMPUTED alias should fall off it.
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PROBE_N ?? 200_000);
const g = tsDeserialize(
  Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"name":"n${i}","age":${i % 90}}}`,
  ).join('\n'),
  'ndjson',
  new TsGraph(),
);

const QUERIES: [string, string][] = [
  ['ORDER BY plain alias', 'MATCH (n:Person) RETURN n.age AS a ORDER BY a LIMIT 10'],
  ['ORDER BY input expr', 'MATCH (n:Person) RETURN n.age AS a ORDER BY n.age LIMIT 10'],
  ['ORDER BY COMPUTED alias', 'MATCH (n:Person) RETURN n.age + 1 AS a ORDER BY a LIMIT 10'],
  ['ORDER BY computed expr', 'MATCH (n:Person) RETURN n.age + 1 AS a ORDER BY n.age + 1 LIMIT 10'],
  ['ORDER BY two cols', 'MATCH (n:Person) RETURN n.age AS a, n.name AS b ORDER BY a LIMIT 10'],
  ['ORDER BY alias of a FUNC', 'MATCH (n:Person) RETURN upper(n.name) AS a ORDER BY a LIMIT 10'],
];

const reps = Number(process.env.PROBE_REPS ?? 5);

for (const [name, q] of QUERIES) {
  const times: number[] = [];
  let rows = 0;

  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    const out = tsQuery(g, q);

    times.push(performance.now() - t);
    rows = out.length;
  }

  console.error(
    `${name.padEnd(26)} min ${Math.min(...times)
      .toFixed(1)
      .padStart(7)}ms  rows=${rows}`,
  );
}
