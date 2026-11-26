/**
 * **WHAT DOES THE CSR BUILD ACTUALLY COST? (item 2253)** This is the number that decides whether
 * `second-ask.ts`'s policy could be relaxed. The policy forgets every shape when `topologyVersion` moves,
 * so an interleaved workload never reaches a second ask and never gets the CSR route (items 2251/2252). The
 * candidate change is to remember shapes ACROSS versions: a genuinely one-shot query still declines
 * (it has never asked that shape), while an interleaved one arms on its first ask of each new version.
 *
 * **THE DECISION IS ARITHMETIC**, and it needs three measurements on the same fixture:
 *
 *     slowRead            a read with NO CSR                  (what interleaving pays today)
 *     build + fastRead    ask #2 of a shape, which builds     (what the change would pay per version)
 *     fastRead            ask #3+, cached                     (the steady state)
 *
 * The change wins at one-read-per-version iff `build + fastRead < slowRead`. If it loses, that IS the
 * 1.64x cold regression the policy exists to prevent, and the lever is dead — which is worth knowing
 * before touching a policy whose own doc calls itself "the item".
 *
 * The JIT must be warmed on a DIFFERENT shape first, or ask #1 of the measured shape carries tiering
 * and the build is unreadable. `warm` does that.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, in_, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) => `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 97}}}`,
  );
  let id = 0;

  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < N; i += 1) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["E"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

const g = deserialize(doc, 'ndjson', new Graph());

/*
 * **WARM THE IN DIRECTION, MEASURE THE OUT DIRECTION.** `seenBefore(graph, forward, type)` keys on the
 * DIRECTION, so `in_('E')` and `out('E')` are different records while running the SAME rung and the same
 * code. That warms the JIT fully and leaves the measured shape's CSR unarmed — which a first attempt got
 * wrong twice: warming on the measured shape itself armed it, and switching to a 2-hop shape left the CSR
 * rung entirely, so the series showed only smooth JIT decay and no build step at all.
 */
const warmPlan = traversal(V(), hasLabel('User'), in_('E'), values('team'));

for (let r = 0; r < 6; r += 1) {
  toArray(warmPlan, g);
}

/*
 * The second-ask record is keyed per (graph, tv, shape), so this OUT shape has never been asked: ask #1
 * declines the CSR, ask #2 builds it, ask #3+ is cached. The per-ask series is therefore the whole
 * measurement — printed, not summarized, because the build is ONE rep.
 */
const freshPlan = traversal(V(), hasLabel('User'), out('E'), values('team'));
const series: number[] = [];
let rows = 0;

for (let r = 0; r < 10; r += 1) {
  const t = performance.now();

  rows = toArray(freshPlan, g).length;
  series.push(performance.now() - t);
}

console.log(`  N=${N}  rows=${rows}`);
console.log(`  per-ask series  ${series.map((x) => x.toFixed(2)).join('  ')}`);
console.log(
  `  ask1 ${series[0]?.toFixed(2)}   ask2 ${series[1]?.toFixed(2)}   ask3 ${series[2]?.toFixed(2)}   steady ${(series.slice(4).reduce((a, b) => a + b, 0) / Math.max(series.length - 4, 1)).toFixed(2)} ms`,
);
