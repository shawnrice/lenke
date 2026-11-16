// Item 2034 — WHAT IS THE CEILING FOR A START-DRIVEN ARM ON `MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5`?
//
// Item 2033 counted the realistic (`MIXED=1`) hop count doing **240,000,000 label tests to return 621
// rows**: `tallyHopCount` walks all 60,000 edges and tests both endpoints' labels per edge, while the
// start predicate selects 207 of 20,001 vertices — about 1%.
//
// ⚠️⚠️ **AND I OWE A CORRECTION TO MY OWN ITEM 2033 FRAMING BEFORE MEASURING ANYTHING.** That item said
// a start-driven walk visits "621 edges, ~100x fewer than 60,000", which is true of EDGES and
// misleading about the SPEEDUP: `k` is unindexed, so a start-driven arm still scans all 20,001
// vertices to find the 207. Its total work is ~20,622 visits against the edge arm's 60,000 edges and
// 120,000 label tests — a single-digit ratio, not 100x. This probe measures the arm rather than
// arguing about it, which is the whole point.
//
// 🔑 THE ROUTE MAP (item 1942) IS INDEXED BY **LABEL** SELECTIVITY ONLY:
//
//     start label        far label         arm
//     vacuous/absent     vacuous/absent    CSR, counting
//     vacuous/absent     broad non-vac     CSR + per-slot far test
//     broad non-vac      anything          EDGE-driven, both tested   <- THIS FIRES HERE
//     selective          anything          start-driven (bucket)
//
// `P` covers 20000/20001 = 0.99995, so "broad non-vacuous" is correct and the edge-driven arm is the
// right answer to the question the gate ASKS. The unweighed term is the start PREDICATE's
// selectivity, which no row considers.
//
// ⚠️ HAND ARMS ARE THE ESTABLISHED COMPARATOR for this family (item 1936 measured the edge-driven
// hand shape at 34 ns a row; item 1942 asked what the arm costs against it). A hand arm is a CEILING,
// not a candidate: it knows the query at author time and the engine cannot.
//
// ⚠️ EVERY ARM ASSERTS 621 against an INDEPENDENT closed-form oracle, because an arm that answers
// differently is not a faster route, it is a wrong one.
//
//     bun startdriven-ceiling-2034.mjs
//     REPS=9 NODES=50000 bun startdriven-ceiling-2034.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const OPS = Number(process.env.OPS ?? 200);
/*
 * ⚠️⚠️ **SEL IS THE TERM THE GATE CANNOT SEE, AND THE WORST CASE DECIDES THE POLICY** (item 2035).
 * `k = 5` keeps 1% of starts; `k >= 0` keeps ALL of them. A start-driven arm visits |V| vertices and
 * THEN their edges, so against the tally's |E| it wins by skipping edges and loses by scanning
 * vertices. At SEL=all it can only lose, and by how much is what says whether "prefer start-driven
 * whenever the far side is labelled" is safe or needs a selectivity estimate the engine does not
 * have. Measuring the arm I want to build in the regime where it is WRONG is the point.
 */
const SEL = process.env.SEL ?? 'one';

const WHERE = SEL === 'all' ? 'a.k >= 0' : 'a.k = 5';
const keeps = SEL === 'all' ? () => true : (k) => k === 5;
const Q = `MATCH (a:P)-[:E]->(b:P) WHERE ${WHERE} RETURN count(*) AS c`;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

/*
 * ⚠️ ONE ISOLATED OFF-LABEL VERTEX — the realistic mode, and the whole reason this shape is slow.
 * `vacuousLabel` is an EXACT equality against `vertexCount`, so this single vertex moves the query
 * off the eliding arm permanently. It has no edges, so every answer is unchanged.
 */
g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { k: -1, s: 'off', n: -1 } });

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    // ⚠️ SPLIT ON THE REPEAT INDEX: `to = (a*k + b) % N` is invariant under `k -> k + N`, so without
    // the `hop` term all of one vertex's FANOUT edges land on the SAME target and the graph is
    // FUNCTIONAL while out-degree looks perfect (CLAUDE.md's generator trap, found in six generators
    // at items 1516/1518).
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % NODES}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

// The oracle: recomputed from the fixture's closed form, with no Graph and no engine call.
/*
 * ⚠️⚠️ **INDEXED=1 IS THE ARM THAT MATTERS, and the SEL grid is why** (item 2035). Start-driven is
 * 3.13x BETTER at 1% selectivity and 3.46x WORSE at 100%, so "prefer it when the far end is
 * labelled" is unsafe and the gate needs a real selectivity SIGNAL. An unindexed `k` offers none.
 * An INDEX does: `hopSeek` returns a narrow seed, and the engine then knows the candidate set is
 * small WITHOUT estimating anything. This knob asks whether the engine takes that route when the far
 * end is labelled — `startWalkFits` requires `pb === undefined`, so the prediction is that it does
 * NOT, and falls to the full edge scan with the selectivity signal in hand.
 */
if (process.env.INDEXED === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

const expected = (() => {
  let rows = 0;

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    if (keeps((e % NODES) % 97)) {
      rows += 1;
    }
  }

  return rows;
})();

// ⚠️ DISTINCT ENDPOINTS, because out-degree cannot see the collapse above.
const reach = new Set();

for (let e = 0; e < NODES * FANOUT; e += 1) {
  reach.add(((e % NODES) * 7 + 3 + Math.floor(e / NODES) * 2_654_435_761) % NODES);
}

if (reach.size < NODES * 0.5) {
  throw new Error(
    `fixture reaches only ${reach.size} of ${NODES} — DEGENERATE, nothing here is valid`,
  );
}

const engine = () => Number(query(g, Q)[0].c);

/*
 * The hand START-DRIVEN arm: find the matching starts, then walk only THEIR edges. This is the arm
 * the route map calls "start-driven (bucket)" and reserves for a SELECTIVE LABEL — here the label is
 * broad and the PREDICATE is selective, which is the case no row covers.
 */
const handStartDriven = () => {
  let rows = 0;

  for (const v of g.vertices) {
    if (!keeps(v.properties.k) || !v.labels.has('P')) {
      continue;
    }

    const byLabel = g.edgesFromByLabel.get(v.id);
    const bucket = byLabel?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.to.labels.has('P')) {
        rows += 1;
      }
    }
  }

  return rows;
};

/** The hand EDGE-driven arm — what the engine currently does, as the like-for-like floor. */
const handEdgeDriven = () => {
  let rows = 0;
  const bucket = g.edgesByLabel.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('P') && keeps(edge.from.properties.k) && edge.to.labels.has('P')) {
        rows += 1;
      }
    }
  }

  return rows;
};

const ARMS = {
  'engine (edge-driven)': engine,
  'HAND start-driven': handStartDriven,
  'HAND edge-driven': handEdgeDriven,
};

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const got = fn();

  if (got !== expected) {
    throw new Error(`${name} answered ${got}, expected ${expected} — NOT answer-equivalent`);
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    for (let o = 0; o < OPS; o += 1) {
      fn();
    }

    series.push(performance.now() - t0);
  }

  /*
   * ⚠️ MEDIAN OF THE PLATEAU, not min-of-N: the TS paths tier up visibly over the first reps and a
   * rare fast rep makes `min` report a mode the arm does not hold (CLAUDE.md's estimator note). The
   * series is printed so the reader can check the plateau rather than trust the summary.
   */
  const plateau = series.slice(3).sort((a, b) => a - b);
  const median = plateau[Math.floor(plateau.length / 2)];

  results[name] = median;
  console.log(
    `  ${name.padEnd(24)} ${median.toFixed(1).padStart(9)} ms / ${OPS} ops   series ${series.map((x) => x.toFixed(0)).join(' ')}`,
  );
}

console.log(
  `\n  SEL=${SEL} (${WHERE}), answer ${expected} rows, ${NODES} vertices + 1 off-label, ${NODES * FANOUT} edges, ${reach.size} distinct targets\n` +
    `  start-driven is ${(results['engine (edge-driven)'] / results['HAND start-driven']).toFixed(2)}x the engine\n` +
    `  the engine is ${(results['engine (edge-driven)'] / results['HAND edge-driven']).toFixed(2)}x its OWN hand shape (edge-driven)\n`,
);
