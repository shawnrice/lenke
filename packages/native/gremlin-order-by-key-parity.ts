import { Graph } from '@lenke/core';
import { order, out, toArray, traversal, V, values } from '@lenke/gremlin';

/**
 * DO TS AND NATIVE AGREE, POSITIONALLY, ON `V().out(T).order().by(k)`? (item 1783)
 *
 * ⚠️ WRITTEN BECAUSE THE GREMLIN FUZZER CANNOT GENERATE THIS SHAPE AT ALL. Every `by()` modulator in
 * `gremlin-fuzz.test.ts` is a COMPARATOR TOKEN — 8 × `.by(desc)` and 3 × `.by(Order.desc)`, and zero
 * with a property key. So `order().by('s')`, the shape item 1783 gave a new route, is outside its
 * corpus, and `bun run fuzz` green says nothing about it. Found by enumerating the generator's
 * `by()` calls rather than by trusting the suite.
 *
 * ⚠️ THIRD BLINDNESS FINDING IN THIS ARC, AND ALL THREE ARE DIFFERENT. Item 1776's unordered page was
 * ABSENT from the corpus; item 1781's filtered hop projection was PRESENT UNDER A COUNTER THAT NAMED
 * IT (`hopFilter`, which requires `count(*)`); this one's step is generated 59 times but only ever
 * with the wrong modulator kind. The generator's shape space has to be read on the axis the change
 * moves — here the `by()` argument, not the `order()` step.
 *
 * ⚠️ AND THE ORACLE IS POSITIONAL, WHICH IS THE OPPOSITE OF THE GQL ONE. Item 1781's
 * `far-driven-predicated-parity.ts` compares MULTISETS, because an unordered GQL projection's row
 * order is unspecified. Here order IS the contract: Gremlin stream order is TinkerPop's and the
 * differential fuzzer compares it ordered, which is exactly why the GQL far-driven route is not
 * available on this surface (`far-filtered-hop-values.test.ts`). A positional difference here is a
 * BUG, not a licensed reordering.
 *
 *     cd packages/native && bun gremlin-order-by-key-parity.ts
 *
 * Exits non-zero on any positional mismatch, or on a case that produced no rows — a shape that
 * matches nothing agrees with a broken one trivially (item 1416).
 */
import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = Number(process.env.NODES ?? 24);
const lines: string[] = [];

for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'node',
      id: `v${i}`,
      labels: ['P'],
      properties: {
        // ⚠️ THE KEY IS DESCENDING IN `i`, AND IT MUST NOT BE DERIVED FROM THE EDGE PERMUTATION.
        // The first version of this probe used `(i * 7 + 3) % NODES` for BOTH the key and the edge
        // target, which made the walk order already equal the sorted order — so sorted and
        // UNSORTED output were byte-identical and every "IDENTICAL" verdict below was vacuous. A
        // probe that cannot tell a sorted result from an unsorted one is the defect items 1064,
        // 1777 and 1781 each paid for. `assertFixtureCanFail` at the bottom now enforces it.
        //
        // Zero-padded so lexicographic and numeric order agree: a disagreement is then about the
        // ROUTE, not about string collation, which `gremlin-order-codepoint-probe.mjs` owns.
        s: `k${String(NODES - 1 - i).padStart(3, '0')}`,
        n: NODES - 1 - i,
        // TIES, deliberately: a stable sort must keep the walk's relative order among equal keys,
        // and that is the part a route change is most likely to alter.
        tie: i % 3,
      },
    }),
  );
}

for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'edge',
      id: `e${i}`,
      from: `v${i}`,
      to: `v${(i * 7 + 3) % NODES}`,
      labels: ['E'],
    }),
  );
}

const distinctEnds = new Set(Array.from({ length: NODES }, (_, i) => (i * 7 + 3) % NODES)).size;

if (distinctEnds !== NODES) {
  console.error(`fixture: ${distinctEnds} distinct endpoints for ${NODES} edges — degenerate`);
  process.exit(1);
}

const NDJSON = lines.join('\n');

const tsGraph = new Graph();

for (let i = 0; i < NODES; i++) {
  tsGraph.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: {
      s: `k${String(NODES - 1 - i).padStart(3, '0')}`,
      n: NODES - 1 - i,
      tie: i % 3,
    },
  });
}

// NON-NULL ASSERTED VIA A CHECK rather than `!`: every id was just added above, so a null here
// would mean the fixture did not build, which is worth failing loudly instead of at the edge.
const verts = Array.from({ length: NODES }, (_, i) => {
  const v = tsGraph.getVertexById(`v${i}`);

  if (v === null) {
    throw new Error(`fixture: v${i} was added but cannot be read back`);
  }

  return v;
});

for (let i = 0; i < NODES; i++) {
  tsGraph.addEdge({
    id: `e${i}`,
    from: verts[i],
    to: verts[(i * 7 + 3) % NODES],
    labels: ['E'],
  });
}

const backend = nativeBackend();
const nativeGraph = graphFromNdjson(backend, NDJSON);

/** Element rows reduced to their ids, which is the comparable projection of a vertex stream. */
const idsOf = (rows: unknown): string[] =>
  (rows as { id?: string }[]).map((r) => (typeof r?.id === 'string' ? r.id : JSON.stringify(r)));

type Case = {
  readonly name: string;
  readonly ts: () => unknown;
  readonly native: string;
  /** Does this case ride the route item 1783 changed, or is it a control on an untouched one? */
  readonly admitted: boolean;
};

const CASES: readonly Case[] = [
  {
    name: 'out + order by string key',
    ts: () => toArray(traversal(V(), out('E'), order().by('s')), tsGraph),
    native: "g.V().out('E').order().by('s')",
    admitted: true,
  },
  {
    name: 'out + order by numeric key',
    ts: () => toArray(traversal(V(), out('E'), order().by('n')), tsGraph),
    native: "g.V().out('E').order().by('n')",
    admitted: true,
  },
  {
    name: 'out + order by a TIED key (stability)',
    ts: () => toArray(traversal(V(), out('E'), order().by('tie')), tsGraph),
    native: "g.V().out('E').order().by('tie')",
    admitted: true,
  },
  {
    name: 'CONTROL: values + order (untouched value-mode fusion)',
    ts: () => toArray(traversal(V(), out('E'), values('s'), order()), tsGraph),
    native: "g.V().out('E').values('s').order()",
    admitted: false,
  },
  {
    name: 'CONTROL: bare hop (untouched, rest empty)',
    ts: () => toArray(traversal(V(), out('E')), tsGraph),
    native: "g.V().out('E')",
    admitted: false,
  },
];

let bad = 0;

for (const c of CASES) {
  const tsRows = c.ts();
  const natRows = nativeGraph.gremlin(c.native);
  const a = JSON.stringify(idsOf(tsRows));
  const b = JSON.stringify(idsOf(natRows));
  const rowCount = (tsRows as unknown[]).length;
  const same = a === b;
  const empty = rowCount === 0;

  if (!same || empty) {
    bad += 1;
  }

  console.log(
    `${c.name.padEnd(48)} rows ${String(rowCount).padStart(3)}  ${
      same ? 'IDENTICAL' : 'POSITIONAL MISMATCH'
    }${empty ? '  ⚠️ EMPTY' : ''}${c.admitted ? '  [admitted]' : '  [control]'}`,
  );

  if (!same) {
    console.log(`    ts     ${a}`);
    console.log(`    native ${b}`);
  }
}

/**
 * ⚠️ CAN THIS FIXTURE TELL A SORTED RESULT FROM AN UNSORTED ONE?
 *
 * If the walk's own order already equals the sorted order, every verdict above holds for a reason
 * that has nothing to do with sorting, and a route that dropped the sort entirely would pass. The
 * first version of this probe had exactly that defect. This is the guard, not a comment: the sorted
 * output must DIFFER from the bare hop's.
 */
const sortedIds = JSON.stringify(
  idsOf(toArray(traversal(V(), out('E'), order().by('s')), tsGraph)),
);
const walkIds = JSON.stringify(idsOf(toArray(traversal(V(), out('E')), tsGraph)));

if (sortedIds === walkIds) {
  console.error(
    '\nFIXTURE CANNOT FAIL: the walk order already equals the sorted order, so every verdict above is vacuous.',
  );
  process.exit(1);
}

console.log(
  `\nfixture can fail: sorted != walk order (${sortedIds.slice(0, 40)}… vs ${walkIds.slice(0, 40)}…)`,
);

console.log(
  bad === 0
    ? 'TS and native agree positionally on every case, and none is empty.'
    : `${bad} case(s) failed — a positional mismatch here is a bug, not a licensed reordering.`,
);
process.exit(bad === 0 ? 0 : 1);
