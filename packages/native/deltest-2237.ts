/**
 * **THE DELETION TEST FOR item 2236's `get properties` FRAME (item 2237).** The profile put
 * `get properties` at 59.7 ns of a 346 ns/contribution grouped-hop count — but
 * [[frame-attribution-trap]] says a getter frame is ATTRIBUTION until a deletion test with a CONTROL says
 * otherwise, and `Vertex.ts` already carries a refutation of optimizing that exact getter. So the read is
 * DELETED from the far-keyed walk and the arms compared.
 *
 * **THE DELETED ARM KEEPS THE KEY VARYING.** Substituting a CONSTANT would send every contribution to
 * one `bump` bucket instead of 97, making the Map behave differently and overstating the deletion. A cheap
 * module-scope counter mod 97 keeps the group count and the Map's hit pattern identical, so only the
 * getter call and the keyed index are removed.
 *
 * ONE SHAPE PER PROCESS (items 762, 2172-2175, 2214): `Q` picks one query, and the fixture load is
 * outside the timed region.
 *
 *     Q=farkey   the target  — reads `b.k` PER EDGE   (the line the deletion edits)
 *     Q=startkey CONTROL     — reads `a.k` per ANCHOR (a different line, unreachable by the edit)
 *     Q=plain    CONTROL     — `count(*)`, no property read at all, a different rung
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
const WHICH = process.env.Q ?? 'farkey';

const QUERIES: Record<string, string> = {
  farkey: 'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN b.k AS g, count(*) AS c',
  startkey: 'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.k AS g, count(*) AS c',
  plain: 'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c',
};

const q = QUERIES[WHICH];

if (q === undefined) {
  throw new Error(`unknown Q=${WHICH}`);
}

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

const g = deserialize(doc, 'ndjson', new Graph());
const series: number[] = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = query(g, q);

  sink += out.length; /* cheap sink — item 2227: an expensive one dilutes the ratio toward 1.0 */
  series.push(performance.now() - t0);
}

/*
 * MEDIAN OF THE POST-WARM-UP REPS, not min: the TS scalar path plateaus high and emits a RARE fast rep,
 * so `min` estimates the two arms differently. Drop the first three — visibly the JIT tiering up.
 */
const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `  ${WHICH.padEnd(9)} median ${median.toFixed(1)} ms   rows=${sink / REPS}   series ${series.map((x) => x.toFixed(0)).join(' ')}`,
);
