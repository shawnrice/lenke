/**
 * Which GQL label EXPRESSIONS does `vacuousLabel` elide? (item 1549)
 *
 * `shortcuts.ts`:
 *
 * ```ts
 *   export const vacuousLabel = (graph, expr) =>
 *     expr?.kind === 'label' && (graph.verticesByLabel.get(expr.name)?.size ?? 0) === graph.vertexCount;
 * ```
 *
 * `LabelExpr` has FIVE kinds — `label`, `wildcard`, `not`, `and`, `or` — and only the first is
 * tested. The function's own comment prices what elision is worth: "When every vertex is a
 * `Person`, `MATCH (a:Person)-[:KNOWS]->(x)` and `MATCH (a)-[:KNOWS]->(x)` are EQUIVALENT
 * SPELLINGS of one question — and they cost 586ms against ~0ms".
 *
 * This is the Gremlin bug of item 1547 on the other surface: there `dropVacuousLabels` required
 * `labels.length === 1`, so `hasLabel(P, Q)` stayed in the plan and cost 908x.
 *
 * Every arm answers the SAME number, by construction: `P` is on every vertex, so `:P`, `:P|Q`,
 * `:%` and `:!Nope` all match every one of them, and so does the unlabelled spelling.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i % 97 },
    }),
  );
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: vs[i],
    to: vs[(i * 104_729 + 1) % NODES],
    labels: ['E'],
    properties: {},
  });
}

const ARMS = {
  // The elided spellings, as the yardstick.
  'no label': 'MATCH (a)-[:E]->(x) RETURN count(*) AS c',
  ':P (single)': 'MATCH (a:P)-[:E]->(x) RETURN count(*) AS c',
  // The four `LabelExpr` kinds `vacuousLabel` does not test. Each is vacuous on this graph.
  ':P|Q (or)': 'MATCH (a:P|Q)-[:E]->(x) RETURN count(*) AS c',
  ':Q|P (or, reversed)': 'MATCH (a:Q|P)-[:E]->(x) RETURN count(*) AS c',
  ':% (wildcard)': 'MATCH (a:%)-[:E]->(x) RETURN count(*) AS c',
  ':!Nope (not)': 'MATCH (a:!Nope)-[:E]->(x) RETURN count(*) AS c',
  ':P&P (and)': 'MATCH (a:P&P)-[:E]->(x) RETURN count(*) AS c',
  // CONTROL: a genuinely selective label, which must NOT be elided.
  ':Q (selective)': 'MATCH (a:Q)-[:E]->(x) RETURN count(*) AS c',
};

const only = process.env.ONLY;
const rows = [];

for (const [name, text] of Object.entries(ARMS)) {
  if (only !== undefined && !name.includes(only)) {
    continue;
  }

  let answer;

  try {
    for (let w = 0; w < 3; w += 1) {
      answer = JSON.stringify(query(g, text));
    }
  } catch (e) {
    rows.push({ name, ms: Number.NaN, answer: `ERR ${String(e).slice(0, 50)}` });

    continue;
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, text);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  rows.push({ name, ms: kept[Math.floor(kept.length * 0.25)], answer });
}

console.log(`GQL vacuous label expressions — NODES=${NODES} REPS=${REPS}\n`);

for (const r of rows) {
  const ms = Number.isNaN(r.ms) ? '      —' : r.ms.toFixed(3).padStart(10);

  console.log(`${r.name.padEnd(22)} ${ms} ms   ${r.answer}`);
}
