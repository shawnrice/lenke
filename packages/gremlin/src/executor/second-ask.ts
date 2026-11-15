import type { Graph } from '@lenke/core';

/*
 * ⚠️ A LEAF MODULE, and item 1983 is why. This policy lived in `hop-values-csr.ts` while its five
 * callers were all hop-values walks, which import that file anyway. The two-hop COUNT needs it too
 * (`count-shortcut.ts`), and that file is imported BY `hop-values-csr.ts` — so importing it the
 * other way produced a dependency cycle the lint refused. Extracting the policy is the fix the lint
 * itself names, and it is the right shape regardless: the second-ask decision is about a graph and a
 * hop shape, and depends on nothing else in the executor.
 *
 * `hop-values-csr.ts` re-exports it, so its existing importers are untouched.
 */
/**
 * Has this (graph, topology version, hop shape) been asked for BEFORE? The first ask returns
 * `false` and records it; every later ask returns `true`.
 *
 * ⚠️⚠️ **THIS POLICY IS THE ITEM.** The CSR is keyed on `topologyVersion`, so the first query after
 * any topology write pays the build — and `hop-values.ts` priced exactly that at items 1693/1694
 * without settling it ("`handCsrPlusBuild` 167.00 ms, **0.83x**, the FIRST query only"). Measured
 * here with a kill-switch A/B at 200,000 vertices / 1,000,000 edges, three order-alternated rounds,
 * BEFORE this policy existed:
 *
 * ```text
 *   hop   WARM   89.0 93.6 83.9  ->  42.3 48.9 42.1     2.10x
 *   hop   COLD  106.7 109.2 110.1 -> 181.2 180.0 165.5   0.61x   ⬅ a 1.64x REGRESSION, first query
 *   hop2  [control]                                      1.09x
 *   optional [control]                                   1.06x
 * ```
 *
 * So the warm win is real and the cold loss is real, which is why the lever sat open for ~200 items.
 * Deferring the build to the SECOND ask removes the loss without touching the win:
 *
 *   - a ONE-SHOT query never builds, and pays nothing;
 *   - a WRITE-HEAVY workload (write, read, write, read) never reaches a second ask on any one
 *     topology version, so it never builds either — which is the case item 1694 was most worried
 *     about and the reason the key includes the version;
 *   - a repeated read pays the build once and wins from then on.
 *
 * ⚠️ IT IS A ROUTE CHOICE, SO IT IS ANSWER-EQUIVALENT AND EVERY MUTANT OF IT SURVIVES THE
 * BEHAVIOURAL TESTS — [[perf-gate-needs-its-own-test]]. Hence a pure function with its own unit
 * test, which is what item 1776 did for `unsortedPageRoute`.
 *
 * ⚠️ AND IT IS KEYED ON THE VERSION, NOT MERELY STAMPED WITH IT: a generation is dropped WHOLE on
 * any topology write, the same discipline `chainCsrCache` uses, so nothing leaks one dead entry per
 * shape per write.
 */
const seen = new WeakMap<Graph, { tv: number; shapes: Set<string> }>();

export const seenBefore = (graph: Graph, forward: boolean, type: string): boolean => {
  const tv = graph.topologyVersion;
  let entry = seen.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    entry = { tv, shapes: new Set() };
    seen.set(graph, entry);
  }

  const key = `${forward ? '>' : '<'}${type}`;

  if (entry.shapes.has(key)) {
    return true;
  }

  entry.shapes.add(key);

  return false;
};
