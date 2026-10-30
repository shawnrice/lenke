// The A/B instrument for item 1246's per-endpoint extremum fold.
//
// ⚠️ WHY NOT `bun run bench`: item 1245 measured that instrument's drift at ~25% per arm (its
// control moved 1.26x when it could not be reached at all), which is larger than the effect being
// claimed here. This runs ONE process per arm and measures the engine only.
//
// TWO CONTROLS, both in the same process and the same shape family, both of which the primed path
// provably DECLINES — so if they move with the target, the instrument moved and not the code:
//
//   - `count(*), max(x.name)` — a `rows` accumulator makes `allExtrema` false, and count(*) needs
//     the multiplicity the endpoint fold throws away;
//   - `min(a.name), max(a.name)` — reads the START variable, so `freePredicateVars` is `{a}` and
//     the argument check refuses it.
//
// Both still go through `detectMultiHopAggregate`'s row walk, which this change does not touch.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.AB_N ?? 200_000);
const REPS = Number(process.env.AB_REPS ?? 7);

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90},"name":"person${i}","city":"city${i % 8}"}}`,
  );

  for (let k = 0; k < N * 5; k++) {
    lines.push(
      `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${(k * 104_729) % N}","properties":{}}`,
    );
  }

  return lines.join('\n');
})();

const graph = tsDeserialize(doc, 'ndjson', new Graph());

const CASES: readonly [string, string][] = [
  [
    'string  min+max over x',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.name) AS lo, max(x.name) AS hi',
  ],
  [
    'dict    min+max over x',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.city) AS lo, max(x.city) AS hi',
  ],
  [
    'number  min+max over x',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.age) AS lo, max(x.age) AS hi',
  ],
  // The SINGLE-aggregate spelling of the same question. Item 1246 wired the per-endpoint fold into
  // `detectMultiHopAggregate` only; `detectHopAggregate` runs EARLIER in the ladder and claims a
  // one-item projection, so these are the "grep the pattern elsewhere" check.
  ['single  min over x', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.name) AS v'],
  ['single  max over x', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN max(x.age) AS v'],
  // The two sites item 1246 DECLINED, priced before either is touched (item 1248).
  // Undirected: `-[:T]-` tests both buckets and has its own self-loop arithmetic (items 480-483).
  [
    'undirected min+max',
    'MATCH (a:Person)-[:KNOWS]-(x) RETURN min(x.name) AS lo, max(x.name) AS hi',
  ],
  // Grouped: min/max over a multiset is per-GROUP idempotent too, but the group key changes which
  // endpoints share a fold.
  [
    'grouped by far prop',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.city AS c, min(x.age) AS lo ORDER BY c',
  ],
  // Is the ORDER BY what disqualifies the grouped rung, or is the rung slow? Item 1248 priced the
  // ordered spelling at 664932 us and left this unchecked against `sortsOnOutputOnly`.
  ['grouped no order', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.city AS c, min(x.age) AS lo'],
  ['grouped count only', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.city AS c, count(*) AS n'],
  // The grouped NODE twin, which shares the hop rung's body AND its blanket `orderBy` refusal.
  ['node grouped no order', 'MATCH (x:Person) RETURN x.city AS c, min(x.age) AS lo'],
  ['node grouped ordered', 'MATCH (x:Person) RETURN x.city AS c, min(x.age) AS lo ORDER BY c'],
  [
    '[CTL] count(*) + max',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c, max(x.name) AS hi',
  ],
  [
    '[CTL] min+max over a',
    'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(a.name) AS lo, max(a.name) AS hi',
  ],
];

// ⚠️ ONE SHAPE PER PROCESS when `AB_CASE` is set, and that is the only honest way to read the
// controls. Item 762's rule (recorded in CLAUDE.md): an in-process A/B flatters any change that
// REDISTRIBUTES call sites, and the giveaway is a control moving with the target. Running all five
// here showed both controls 1.03-1.07x slower in POST; an ABLATION — the same code admitting
// nothing — returned them to their PRE readings, proving the slowdown came from the primed path
// POLLUTING the inline caches of `matchesLabel`, the folds and the compiled-argument call sites
// that the row walk shares with it, not from the change itself.
const only = process.env.AB_CASE;
const selected = only === undefined ? CASES : CASES.filter(([n]) => n.includes(only));

if (selected.length === 0) {
  console.error(`AB_CASE=${only} matched no case`);
  process.exit(2);
}

console.log(`\n# ${N} nodes, ${N * 5} edges, min of ${REPS} reps\n`);

for (const [name, q] of selected) {
  const runs: number[] = [];
  let answer = '';

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const rows = tsQuery(graph, q);

    runs.push((performance.now() - t0) * 1000);
    answer = JSON.stringify(rows);
  }

  // The ANSWER is printed with the time, so an arm that got faster by answering a different
  // question cannot be read as a win (item 702's rule, applied per row).
  console.log(
    `  ${name.padEnd(26)} ${Math.min(...runs)
      .toFixed(1)
      .padStart(10)} us   ${answer}`,
  );
}
