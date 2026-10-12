/**
 * What does deleting an element cost as a function of its PROPERTY WIDTH?
 *
 *   cd packages/native && bun run delete:width
 *   DW_N=50000 DW_REPS=9 bun run delete:width
 *
 * This exists because `bench:usage` cannot answer the question and quietly looks like it can.
 * Its fixture gives a node three or four properties, so an O(width) cost inside a delete is
 * invisible there — and at item 334 a change that removed exactly such a cost measured FLAT on
 * every row of that harness while being worth 1.9x here at width 256. Two separate traps in one
 * row: the fixture did not vary the thing the claim was about, and `bench:usage`'s own
 * unreachable control row ranged 1.7x across three rounds, which is a noise floor no
 * single-digit-percent flag can clear.
 *
 * It imports `@lenke/core`'s SOURCE rather than its built dist, deliberately: the dist is what
 * the fuzzers and the cross-engine benches must read, but a build between an edit and a
 * measurement makes an A/B cost minutes instead of seconds, and that cost is why the width
 * sweep did not exist. Nothing here is byte-identity sensitive — it reports times, not results.
 *
 * READING IT. `del_ns/node` is the number to watch: flat across the sweep means the delete is
 * O(1) in width, and a straight line means something per-property is running. At item 334 the
 * line was the unconditional `{ ...vertex.properties }` and `[...vertex.labels]` that
 * `removeVertex` / `removeEdge` took to capture rollback state — allocated on every removal,
 * and read only by an undo closure that `recordUndo` discarded outside a transaction. Inside
 * one, the copies are still taken and this row is expected to climb again; that is the control
 * the fix cannot reach and it is measured below.
 */
// Deliberate reach-in, and the case the rule's own message names: a source import that avoids a
// build step. This is a PROBE, not a fuzzer or a cross-engine bench, so it is not byte-identity
// sensitive and has no reason to read the dist. Going through `@lenke/core` would put a full
// `bun run build` between every edit and every measurement, turning a seconds-long A/B into a
// minutes-long one — and that cost is exactly why this width sweep did not exist before item 334.
// oxlint-disable-next-line boundaries/no-cross-package-relative-import -- probe reads source to skip the build step
import { Graph } from '../core/src/index.ts';

const N = Number(process.env.DW_N ?? 20_000);
const REPS = Number(process.env.DW_REPS ?? 7);
const WIDTHS = [4, 16, 64, 256];

const props = (w: number, i: number): Record<string, unknown> => {
  const o: Record<string, unknown> = {};

  for (let k = 0; k < w; k++) {
    o[`k${k}`] = `v${i}_${k}`;
  }

  return o;
};

/** Min-of-REPS for one (width, mode) cell. The add is setup, so only the delete loop is timed. */
const measure = (w: number, inTransaction: boolean): { add: number; del: number } => {
  let add = Infinity;
  let del = Infinity;

  for (let r = 0; r < REPS; r++) {
    const g = new Graph();
    const ids: string[] = [];
    let t = performance.now();

    for (let i = 0; i < N; i++) {
      ids.push(g.addVertex({ id: `n${i}`, labels: ['P'], properties: props(w, i) }).id);
    }

    add = Math.min(add, performance.now() - t);
    t = performance.now();

    if (inTransaction) {
      // The control: a rollback is possible here, so the state capture is NOT dead and the
      // per-property cost must still be paid.
      g.transaction(() => {
        for (const id of ids) {
          g.removeVertex(id);
        }
      });
    } else {
      for (const id of ids) {
        g.removeVertex(id);
      }
    }

    del = Math.min(del, performance.now() - t);
  }

  return { add, del };
};

/** Min-of-REPS for one SET-by-width cell: a single-property write on an element of width `w`. */
const measureSet = (w: number): number => {
  let lo = Infinity;

  for (let r = 0; r < REPS; r++) {
    const g = new Graph();
    const vs = Array.from({ length: N }, (_, i) =>
      g.addVertex({ id: `n${i}`, labels: ['P'], properties: props(w, i) }),
    );
    const t = performance.now();

    // ONE property per write, which is the shape that matters: an immutable bag means a
    // single-key SET rebuilds the whole bag, so its cost is O(width) however narrow the write.
    for (const v of vs) {
      v.setProperty('k0', 'changed');
    }

    lo = Math.min(lo, performance.now() - t);
  }

  return lo;
};

console.log(`\n${N} nodes, best of ${REPS}. Times in ms; del_ns/node is the per-element cost.\n`);
console.log('width   add_ms   del_ms  del_ns/node    del_ms(txn)  txn_ns/node     set_ns/write');

for (const w of WIDTHS) {
  const plain = measure(w, false);
  const txn = measure(w, true);
  console.log(
    [
      String(w).padStart(5),
      plain.add.toFixed(2).padStart(8),
      plain.del.toFixed(2).padStart(8),
      ((plain.del * 1e6) / N).toFixed(0).padStart(12),
      txn.del.toFixed(2).padStart(15),
      ((txn.del * 1e6) / N).toFixed(0).padStart(12),
      ((measureSet(w) * 1e6) / N).toFixed(0).padStart(17),
    ].join(''),
  );
}
