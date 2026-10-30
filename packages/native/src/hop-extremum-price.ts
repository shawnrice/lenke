// Pricing probe for the UNGROUPED HOP EXTREMUM in the TS engine (item 1245).
//
// `MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.name), max(x.name)` has no shortcut: the detector
// index in `executor/shortcuts.ts` names `detectNodeAggregate` (one, scan),
// `detectMultiNodeAggregate` (two or more, scan — gated on `unfilteredScan`) and
// `detectGroupedHopAggregate` (grouped), and NOTHING for the ungrouped hop. Item 1244's sweep
// measured the three rows at 131-165 ms against native's 2.4-3.4.
//
// ⚠️ THE ALGEBRA THAT MAKES A FAST PATH POSSIBLE, and the reason it does not generalize:
// min/max over a MULTISET equals min/max over its distinct support, so the extremum can be folded
// over the ~200,000 DISTINCT endpoints instead of the ~1,000,000 edges — and no endpoint has to be
// resolved per edge. `count(*)` cannot do this; it needs the multiplicity. `sum`/`avg` cannot
// either. This is an extremum-only identity.
//
// So this probe prices THREE ways of answering the same question, before any detector is written:
//   A. the engine as it stands (the general path);
//   B. per-EDGE fold — iterate the type bucket, resolve each endpoint, read the property;
//   C. per-DISTINCT-ENDPOINT fold — iterate vertices, keep those with a qualifying in-edge
//      (early-exit on the first match), read the property once.
//
// B is here as the control that is NOT the hypothesis: if B already matches the engine, the
// general path's cost IS the per-edge resolve and C's advantage is the one being claimed. If B is
// far below the engine, the cost is somewhere else entirely and C would be priced against a
// phantom.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PRICE_N ?? 200_000);
const REPS = Number(process.env.PRICE_REPS ?? 7);

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

const minOf = (us: number[]): number => Math.min(...us);

const time = (fn: () => unknown): { us: number; answer: string } => {
  let answer = '';
  const runs: number[] = [];

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const got = fn();

    runs.push((performance.now() - t0) * 1000);
    answer = JSON.stringify(got);
  }

  return { us: minOf(runs), answer };
};

// A — the engine.
const engine = time(() =>
  tsQuery(graph, 'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.name) AS lo, max(x.name) AS hi'),
);

// B — per-EDGE fold, the control that is not the hypothesis.
const perEdge = time(() => {
  let lo: string | undefined;
  let hi: string | undefined;

  for (const e of graph.edgesByLabel.get('KNOWS') ?? []) {
    if (!e.from.labels.has('Person')) {
      continue;
    }

    const v = e.to.properties.name as string | undefined;

    if (v === undefined) {
      continue;
    }

    if (lo === undefined || v < lo) {
      lo = v;
    }

    if (hi === undefined || v > hi) {
      hi = v;
    }
  }

  return [{ lo, hi }];
});

// C — per-DISTINCT-ENDPOINT fold, the hypothesis.
const perEndpoint = time(() => {
  let lo: string | undefined;
  let hi: string | undefined;

  for (const x of graph.vertices) {
    // Does x have at least ONE in-edge of this type from a Person? Early-exit on the first.
    const bucket = graph.edgesToByLabel.get(x.id)?.get('KNOWS');

    if (bucket === undefined) {
      continue;
    }

    let reached = false;

    for (const e of bucket) {
      if (e.from.labels.has('Person')) {
        reached = true;
        break;
      }
    }

    if (!reached) {
      continue;
    }

    const v = x.properties.name as string | undefined;

    if (v === undefined) {
      continue;
    }

    if (lo === undefined || v < lo) {
      lo = v;
    }

    if (hi === undefined || v > hi) {
      hi = v;
    }
  }

  return [{ lo, hi }];
});

// D — C plus the UNIVERSAL-LABEL shortcut, which is what native's `for_each_typed_out` does
// (`nodes_with_label(l).len() == live_node_count()`). When every live node carries the label, the
// "does x have a qualifying in-edge" test needs no endpoint resolved at all: a non-empty bucket
// IS a qualifying in-edge. That is the per-in-edge `e.from` resolve C was still paying.
const universal =
  graph.vertexCount === [...graph.vertices].filter((v) => v.labels.has('Person')).length;
const perEndpointUniversal = time(() => {
  let lo: string | undefined;
  let hi: string | undefined;

  if (!universal) {
    return [{ lo: 'N/A', hi: 'N/A' }];
  }

  for (const x of graph.vertices) {
    const bucket = graph.edgesToByLabel.get(x.id)?.get('KNOWS');

    if (bucket === undefined || bucket.size === 0) {
      continue;
    }

    const v = x.properties.name as string | undefined;

    if (v === undefined) {
      continue;
    }

    if (lo === undefined || v < lo) {
      lo = v;
    }

    if (hi === undefined || v > hi) {
      hi = v;
    }
  }

  return [{ lo, hi }];
});

console.log(`\n# ${N} nodes, ${N * 5} edges, min of ${REPS} reps\n`);
console.log(`  A engine (general path)            ${engine.us.toFixed(1).padStart(10)} us`);
console.log(`  B per-edge fold       [CTL]        ${perEdge.us.toFixed(1).padStart(10)} us`);
console.log(`  C per-distinct-endpoint fold       ${perEndpoint.us.toFixed(1).padStart(10)} us`);
console.log(
  `  D per-endpoint + universal label  ${perEndpointUniversal.us.toFixed(1).padStart(10)} us  (universal=${universal})`,
);
console.log(`\n  A answer: ${engine.answer}`);
console.log(`  B answer: ${perEdge.answer}`);
console.log(`  D answer: ${perEndpointUniversal.answer}`);
console.log(`  C answer: ${perEndpoint.answer}`);

// ⚠️ THE ANSWERS MUST AGREE, or the cheaper arm is measuring a different question. Item 702's
// lesson: a fixture whose answer is invariant to the thing being varied cannot validate anything.
const a = JSON.parse(engine.answer) as { lo: unknown; hi: unknown }[];
const b = JSON.parse(perEdge.answer) as { lo: unknown; hi: unknown }[];
const c = JSON.parse(perEndpoint.answer) as { lo: unknown; hi: unknown }[];

const same =
  a[0]?.lo === b[0]?.lo && a[0]?.hi === b[0]?.hi && a[0]?.lo === c[0]?.lo && a[0]?.hi === c[0]?.hi;

console.log(`\n  answers agree: ${same ? 'YES' : 'NO — the comparison is void'}`);

if (!same) {
  process.exitCode = 1;
}
