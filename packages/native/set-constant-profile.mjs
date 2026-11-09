/**
 * WHICH OF `setProperty`'s PER-WRITE CONSTANTS IS THE BIG ONE? (item 1732)
 *
 * Item 861 measured the write and split it by WIDTH: the O(K) pair (spread + freeze) is 21% of a
 * write at k=4 and 38% at k=128, so "62-79% is a per-write CONSTANT". It then listed the constants
 * -- "the validations, three constraint asserts, the `key in properties` test, two box lookups, a
 * `recordUndo` closure and an `EmitterEvent` allocation" -- and priced NONE of them individually.
 * The one lever tried (hoisting the `undoWanted` guard to all eight sites) was refuted and reverted.
 *
 * k=4 is the serving width, where the constants are 79% of a 113 ns write. This profiles that window
 * so the frames nominate which constant, instead of the list being worked through in order.
 *
 * ⚠️ NOMINATION ONLY. A getter or field-read frame is attribution until a deletion test with a
 * control says otherwise (four instances in this repo, and the control moved 7.5x at item 1667).
 *
 * MEASURED, 30,000,000 writes at k=4, DRAIN=1000, 3296 samples (121 ns/write, matching item 861's
 * 113). Self-time shares:
 *
 *     30.4%  #commitNormalized                 <- the spread + freeze + box write
 *     26.1%  setProperty (self)
 *     11.3%  event dispatch   emit 4.2 + snapshotFor 3.6 + hasListeners 2.7 + Graph.emit 0.8
 *     10.0%  reactivity       drainMutations 4.7 + markMutated 3.1 + pushTokens 2.2
 *      4.6%  get properties                    <- THREE reads per write
 *      2.4%  (garbage collector)
 *      2.3%  the three asserts + validatePropertyValue
 *
 * ⚠️ THE `DRAIN` KNOB IS NOT A DETAIL -- IT MOVES THE RANKING. With DRAIN=0 (a synchronous write
 * loop, which is how a write probe is naturally written) `pushTokens` reads 6.6% and
 * `drainMutations` does not appear at all, because `pendingTokens` grows to one entry PER WRITE and
 * the profile charges that growth to the push. Draining every 1000 writes puts `pushTokens` at 2.2%
 * and surfaces the real deferred cost as `drainMutations` 4.7%. The total is the same either way
 * (3636 ms vs 3541 ms), so the synchronous arm looks fine; it just attributes 4.4 points to the
 * wrong frame. Any probe for THIS path must return to the event loop.
 */
import { Graph } from '@lenke/core';

import { profileWindow } from './windowed-profile.mjs';

const VERTS = Number(process.env.VERTS ?? 20_000);
const WRITES = Number(process.env.WRITES ?? 2_000_000);

const g = new Graph();

for (let i = 0; i < VERTS; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { a: i, b: `s${i}`, c: i % 2 === 0, d: i * 0.5 },
  });
}

// Resolve the handles OUTSIDE the window -- `getVertexById` is its own measured cost (item 1729)
// and would otherwise be charged to the write.
const handles = [];

for (let i = 0; i < VERTS; i += 1) {
  handles.push(g.getVertexById(`v${i}`));
}

let sink = 0;

// ⚠️ DRAIN PERIOD. `markMutated` pushes a token per write into a `pendingTokens` array that is only
// cleared by a `queueMicrotask(drainMutations)`. A SYNCHRONOUS write loop never yields, so that
// array grows to one entry PER WRITE and the profile charges the growth to `pushTokens`. Real
// serving code returns to the event loop. DRAIN=0 reproduces the synchronous artifact on purpose.
const DRAIN = Number(process.env.DRAIN ?? 1000);

const out = await profileWindow(process.env.PROF_OUT, async () => {
  for (let w = 0; w < WRITES; w += 1) {
    const v = handles[w % VERTS];

    // An EXISTING key, which is the `had === true` branch -- the common serving case and the one
    // that builds the restore closure rather than the remove closure.
    v.setProperty('a', w);
    sink += 1;

    if (DRAIN > 0 && w % DRAIN === DRAIN - 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }

  return sink;
});

console.log(JSON.stringify({ verts: VERTS, writes: WRITES, sink: out }));
