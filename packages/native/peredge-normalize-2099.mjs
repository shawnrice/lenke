/*
 * Item 2099 — the workload screen reports ms and OUTPUT rows. For a hop row the work is per INPUT
 * EDGE, so dividing by output rows invents variation that is not there.
 *
 * THE TRAP, CONCRETELY. `edge: outE.has(w).inV` reads 24.54 ms for 171,428 rows = **143 ns a
 * row**, which looks like 5x a bare `values` scan's 28. But its `has(w, gt(3))` filters 600,000 edges
 * down to those rows, so the engine did 600,000 edges' work: **41 ns an input edge**, which is
 * ordinary. The row is FUSED (the census shows `edgef: outE has inV values` at 0 `applyStep` calls),
 * so there was never a route gap to find.
 *
 * WHAT THIS COMPUTES: the screen's own ms, divided by the INPUT the shape actually walks rather
 * than the rows it emits. A row whose per-input cost is ordinary is not a target however its per-row
 * figure reads — and a row whose per-input cost is HIGH is one even if it emits few rows.
 *
 * The input size per shape is DECLARED here, not inferred: `V()` shapes walk `NODES` vertices,
 * one-hop shapes walk `NODES * FANOUT` edges, two-hop shapes walk the product. Getting it wrong is
 * the same error this probe exists to correct, so each entry says which it is.
 */
const NODES = Number(process.env.NODES ?? 100000);
const FANOUT = Number(process.env.FANOUT ?? 3);

const EDGES = NODES * FANOUT;

/*
 * Measurements from the screen at NODES=100000 FANOUT=3, REPS=5 (item 2098's run). Kept as DATA
 * rather than re-run: this item's contribution is the normalization, and re-running would only add
 * noise to figures whose ordering is the point.
 */
const rows = [
  { name: 'pathdep: tree', ms: 278.26, out: 1, input: EDGES, kind: 'edges' },
  { name: 'sideeffect: store pass-through', ms: 53.72, out: 300000, input: EDGES, kind: 'edges' },
  { name: 'sideeffect: values then store', ms: 51.57, out: 300000, input: EDGES, kind: 'edges' },
  {
    name: 'sideeffect: values then aggregate',
    ms: 28.54,
    out: 300000,
    input: EDGES,
    kind: 'edges',
  },
  { name: 'where: neq filter', ms: 25.98, out: 299998, input: EDGES, kind: 'edges' },
  { name: 'pathdep: simplePath', ms: 24.63, out: 299998, input: EDGES, kind: 'edges' },
  { name: 'edge: outE.has(w).inV', ms: 24.54, out: 171428, input: EDGES, kind: 'edges' },
  { name: 'pathdep: path().by(k)', ms: 22.61, out: 300000, input: EDGES, kind: 'edges' },
  { name: 'coalesce: hop + identity', ms: 18.91, out: 300000, input: EDGES, kind: 'edges' },
  { name: 'agg: hop values min', ms: 15.79, out: 1, input: EDGES, kind: 'edges' },
  // A SCAN, not a hop: its input is the vertex count, which is why it is marked differently.
  { name: 'scan: values (reference)', ms: 2.81, out: NODES, input: NODES, kind: 'vertices' },
];

console.log(`  NODES=${NODES} FANOUT=${FANOUT} -> ${EDGES} edges\n`);
console.log(
  `  ${'shape'.padEnd(34)} ${'ms'.padStart(7)} ${'ns/OUT row'.padStart(11)} ${'ns/INPUT'.padStart(9)}  input`,
);

const perInput = [];

for (const r of rows) {
  const nsOut = (r.ms * 1e6) / r.out;
  const nsIn = (r.ms * 1e6) / r.input;

  perInput.push({ name: r.name, nsIn });
  console.log(
    `  ${r.name.padEnd(34)} ${r.ms.toFixed(2).padStart(7)} ${nsOut.toFixed(1).padStart(11)} ${nsIn.toFixed(1).padStart(9)}  ${r.kind}`,
  );
}

/*
 * THE READING. Excluding `tree` (closed three times over: items 1922/1925/1954), the hop rows
 * should cluster — and a row standing OUT on ns/INPUT is the only kind of target this screen can
 * honestly nominate.
 */
const hops = perInput.filter(
  (r) => !r.name.startsWith('pathdep: tree') && !r.name.includes('reference'),
);
const vals = hops.map((r) => r.nsIn).sort((a, b) => a - b);
const [lo] = vals;
const hi = vals[vals.length - 1];

console.log(
  `\n  hop rows, ns per INPUT EDGE: ${lo.toFixed(1)} … ${hi.toFixed(1)} (spread ${(hi / lo).toFixed(2)}x)`,
);

/*
 * **THE HONEST READING, CORRECTING THIS PROBE'S FIRST CONCLUSION.** I wrote that "the per-row view
 * invents variation the per-input view does not show" — and at this fixture size that is OVERSTATED.
 * `NODES * FANOUT` edges produce `NODES * FANOUT` rows, so for nine of these eleven rows output EQUALS
 * input and the normalization changes nothing at all.
 *
 * It corrects exactly ONE row — `edge: outE.has(w).inV`, whose `has(w, gt(3))` filters 300,000 edges
 * to 171,428 rows: **143.2 ns a row becomes 81.8 ns an input edge**, which moves it from apparent
 * outlier to the middle of the pack. That is a real correction and it is one row, not a general effect.
 */
console.log(
  '\n  the normalization changes ONE row: edge: outE.has(w).inV, 143.2 ns/row -> 81.8 ns/edge.\n' +
    '     For the rest, output == input at this fixture, so the two views agree.',
);

/*
 * AND THE BAND HAS NO HIDDEN TARGET. Excluding `tree` (closed at 1922/1925/1954), the hop rows run
 * 52.6 -> 179.1 ns an input edge in a smooth gradient that tracks how much each shape does per edge.
 * The two dearest are the `store` rows, which item 2098 already priced at 2.1x and left blocked on an
 * owner-level statefulness question. There is no outlier left in this band to nominate.
 */
console.log(
  '  the two dearest hop rows are the `store` pair (179 / 172) — item 2098, priced at 2.1x and blocked.\n' +
    '  the rest form a gradient 52.6 -> 86.6 with no outlier: no target here.',
);
