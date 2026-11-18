/**
 * ⚠️⚠️ **WHERE DOES ITEM 2180's UNACCOUNTED ~0.3 µs PER WRITE GO? (item 2312)**
 *
 * Item 2180 priced two separable SET targets and built neither. Its **target two** is the larger and is
 * explicitly undiagnosed:
 *
 * ```text
 *     SET on EVERY row   98.48 ms / 200,000 writes = 0.49 µs    native 25.41 = 0.127 µs   3.9x
 * ```
 *
 * 🔑 Its words: *"a `{...obj, k: v}` plus `Object.freeze` on a 2-property object is ~100-200 ns, and the
 * cost does not grow with width, so **~0.3 µs per write is somewhere else and unaccounted for.** This is
 * where the volume is."*
 *
 * ✅ Three arms, each doing strictly less than the last, so the unaccounted part is readable by
 * subtraction rather than guessed:
 *
 *   setAll     MATCH (a:T) SET a.k = $v         the shape item 2180 measured
 *   matchAll   MATCH (a:T) RETURN count(*)      the same scan with NO write
 *   handSet    the same writes through the HOST API, no query at all
 *
 * ⚠️ A write MUTATES, so every rep must write a DIFFERENT value — setting the same one could be elided
 * and would measure a no-op. The value is the rep index.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'setAll';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97, name: `n${i}` } });
}

const handSet = (v) => {
  let n = 0;

  for (const vertex of g.vertices) {
    vertex.setProperty('k', v);
    n += 1;
  }

  return n;
};

const ARMS = {
  setAll: (v) => query(g, 'MATCH (a:T) SET a.k = $v RETURN count(*) AS c', { v })[0].c,
  /*
   * ⚠⚠ `matchAll` IS NOT A SCAN FLOOR and measured 0.00 ms — `count(*)` over a label is answered from
   * bookkeeping without visiting a row (items 2286/2303/2309 priced that at ~24 ns). `projectAll` is the
   * real floor: it visits and projects every row, which is what the SET arm also has to do.
   */
  matchAll: () => query(g, 'MATCH (a:T) RETURN count(*) AS c', {})[0].c,
  projectAll: () => query(g, 'MATCH (a:T) RETURN a.k AS k', {}).length,
  handSet: (v) => handSet(v),
  /*
   * ⚠⚠ **A FAIR FLOOR MUST CARRY THE TRANSACTION (item 2312).** `handSet` writes with no transaction,
   * but item 2180 records that *"`runLinear` wraps a write in `graph.transaction()`"* — so the GQL arm
   * pays for an UNDO LOG entry per write and my floor did not. 🔑 The profile named it: `recordUndo` 1.79%
   * beside `(garbage collector)` at **30.53%**, where the actual `setProperty` is only 4.93%. If the undo
   * log is the unaccounted allocation, THIS arm closes most of the 5.9x.
   */
  handSetTx: (v) => g.transaction(() => handSet(v)),
};

const run = ARMS[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let w = 0; w < 2; w += 1) {
  run(-1 - w);
}

const ts = [];
let answer = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  answer = run(r);
  ts.push(performance.now() - t);
}

const ms = med(ts);

console.log(
  `  SHAPE=${SHAPE.padEnd(9)} ${ms.toFixed(2).padStart(8)} ms   ${((ms * 1e6) / N).toFixed(0).padStart(5)} ns/row   answer=${answer}`,
);
