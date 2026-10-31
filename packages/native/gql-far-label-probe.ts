// IS THE FAR-END LABEL ASYMMETRY ALSO IN THE GQL ENGINE? (item 1302's cross-surface check)
//
//   bun gql-far-label-probe.ts <arm>
//
// CLAUDE.md requires the pattern be grepped elsewhere before an item closes: a user picks GQL xor
// Gremlin, so a surface gap costs half of them, and items 1035/1038 (GQL) then 1043/1044 (Gremlin)
// are the same lever built twice because nobody checked the twin.
//
// In GQL the far-end label is part of the PATTERN (`-[:T]->(b:Employee)`) rather than a separate
// step, so the question is whether the pattern-level label reaches the same fast path the far-end
// property predicate does. The arms are matched on selectivity and answer identically within each
// pair.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.PRED_N ?? 200_000);
const REPS = Number(process.env.PRED_REPS ?? 14);
const arm = process.argv[2] ?? '';
const graph = new Graph();
const ids: string[] = [];

for (let i = 0; i < N; i++) {
  graph.addVertex({
    id: `v${i}`,
    labels: i % 2 === 0 ? ['Person', 'Employee'] : ['Person'],
    properties: { age: i % 90, name: `n${i}` },
  });
  ids.push(`v${i}`);
}

for (let i = 0; i < N; i++) {
  graph.addEdge({
    id: `e${i}`,
    from: graph.verticesById.get(ids[i])!,
    to: graph.verticesById.get(ids[(i * 7 + 3) % N])!,
    labels: ['T'],
    properties: {},
  });
}

const q = (src: string) => () => Number(query(graph, src)[0].c);

const ARMS: Record<string, () => number> = {
  // The far-end LABEL, as a pattern-level label on the target node.
  'far-label': q('MATCH (a)-[:T]->(b:Employee) RETURN count(*) AS c'),
  // The far-end PROPERTY, matched on selectivity (both keep ~half the edges).
  'far-prop': q('MATCH (a)-[:T]->(b) WHERE b.age >= 45 RETURN count(*) AS c'),
  // The same label written as a clause predicate rather than in the pattern — equivalent
  // spellings must cost the same, and this is the pair the TS spelling probe would flag.
  'far-label-clause': q('MATCH (a)-[:T]->(b) WHERE b IS LABELED Employee RETURN count(*) AS c'),
  // DOES THE GAP GENERALIZE PAST LABELS? `shortcuts.ts` carries only `eqProps` and `cmpProps`, so
  // every other lifted family should show the same shape on a far end. Each pair below is matched
  // on selectivity against a served spelling of the SAME question.
  'far-member': q('MATCH (a)-[:T]->(b) WHERE b.age IN [45, 46, 47] RETURN count(*) AS c'),
  'far-member-served': q(
    'MATCH (a)-[:T]->(b) WHERE b.age >= 45 AND b.age <= 47 RETURN count(*) AS c',
  ),
  'far-null': q('MATCH (a)-[:T]->(b) WHERE b.age IS NOT NULL RETURN count(*) AS c'),
  'far-null-served': q('MATCH (a)-[:T]->(b) WHERE b.age >= 0 RETURN count(*) AS c'),

  // THE 2x2 that resolves which number is honest: the spelling probe's fixture put a START label
  // on the pattern (`MATCH (a:P)-...`) and measured only 1.34x, where this probe's start-free
  // pattern measured 12-22x at every size. So the variable is the START, not the scale.
  'sl-pattern': q('MATCH (a:Person)-[:T]->(b:Employee) RETURN count(*) AS c'),
  'sl-clause': q('MATCH (a:Person)-[:T]->(b) WHERE b IS LABELED Employee RETURN count(*) AS c'),

  // CONTROLS the far-end question cannot reach.
  'ctl-bare-hop': q('MATCH (a)-[:T]->(b) RETURN count(*) AS c'),
  'ctl-start-label': q('MATCH (a:Employee)-[:T]->(b) RETURN count(*) AS c'),
  'ctl-scan-prop': q('MATCH (n) WHERE n.age >= 45 RETURN count(*) AS c'),
};

const run = ARMS[arm];

if (run === undefined) {
  console.log(`arms: ${Object.keys(ARMS).join(' ')}`);
  process.exit(2);
}

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t = performance.now();

  answer = run();
  series.push(performance.now() - t);
}

const warm = series.slice(3).sort((a, b) => a - b);
const med = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `${arm}\t${med.toFixed(4)}\t${((med * 1e6) / N).toFixed(2)}\t${answer}\t${series
    .map((s) => s.toFixed(2))
    .join(' ')}`,
);
