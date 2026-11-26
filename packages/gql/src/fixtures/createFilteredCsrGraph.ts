import { Graph } from '@lenke/core';

/**
 * The mixed-label, variable-degree, two-edge-type graph the CSR route tests share — written out
 * BYTE-IDENTICALLY in three test files before item 2406 (`filtered-chain-csr`,
 * `three-hop-gated-degree-product`, `two-hop-filtered-csr`), 35 lines each.
 *
 * What each axis is for, since a fixture that does not vary the thing under test reads as a pass:
 *
 *   labels     one vertex in three carries `Q` as well as `P`, so a label test can be SELECTIVE
 *              rather than vacuous — which matters because `label-vacuity-gates-fast-paths` records
 *              that these routes need a vacuous label to fire at all, so a fixture where every
 *              vertex is `P` measures an arm a real schema cannot reach.
 *   properties `k` spans 19 values, enough for a predicate to cut rows without emptying them.
 *   degree     1-4 per vertex rather than a constant, so a per-edge cost cannot be mistaken for a
 *              per-vertex one (`CLAUDE.md`'s "match the fixture to the claim").
 *   edge type  one in five is `F` rather than `E`, so a type-filtered walk has something to skip.
 *
 * THE EDGE TARGET MIXES THE REPEAT INDEX `r`, AND THAT IS LOAD-BEARING. Any `(a * i + b) % n` is
 * invariant under `i -> i + n`, so a generator that omits `r` gives every one of a vertex's edges
 * the SAME target: out-degree, in-degree and isolated-vertex counts all look perfect while the
 * graph never branches, which makes a k-hop count `deg^k * n` by construction. That is items
 * 1516/1518's defect, found in six probe generators after item 702's parenthetical said the repo's
 * own were fine. The `^ (r * 104_729)` term is what breaks the invariance; no choice of multiplier
 * does.
 */
export const createFilteredCsrGraph = (n = 300): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ((i * 40_503) >>> 3) % 3 === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: ((i * 2_246_822_519) >>> 7) % 19 },
      }),
    );
  }

  let e = 0;

  for (let i = 0; i < n; i += 1) {
    const deg = 1 + ((i * 2654435761) % 4);

    for (let r = 0; r < deg; r += 1) {
      const mix = ((i * 2654435761) ^ ((i >> 7) * 40503) ^ (r * 104_729)) & 0x7fffffff;

      g.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[mix % n],
        labels: [r % 5 === 0 ? 'F' : 'E'],
        properties: {},
      });
      e += 1;
    }
  }

  return g;
};
