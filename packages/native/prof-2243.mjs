/**
 * Profiles the TS side of `count hop + far has` (item 2243) — the shape item 2242 left as one of two where
 * the native engine still wins (5.09x) DESPITE TS having a shortcut for it, so the gap is inside the
 * shortcut rather than a missing one.
 *
 * ⚠️ At 0.33 ms over 80,000 edges TS is already at ~4 ns/edge, well under the ~73 ns a single property read
 * costs — so the shortcut is NOT reading per-edge properties and the profile has to say what it does
 * instead. `PROF_ARM=load` is subtractable; the query arm runs many reps because one is far too short.
 */
import { Graph } from '@lenke/core';
import { V, count, has, hasLabel, out, toArray, traversal } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const REPS = Number(process.env.REPS ?? 300);
const ARM = process.env.PROF_ARM ?? 'farhas';

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 97},"age":${i % 90}}}`,
  );
  let id = 0;

  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < N; i += 1) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["E"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

const plan = traversal(V(), hasLabel('User'), out('E'), has('team', 7), count());
const g = deserialize(doc, 'ndjson', new Graph());

let answer = 0;

if (ARM !== 'load') {
  for (let r = 0; r < REPS; r += 1) {
    const rows = toArray(plan, g);

    if (rows.length !== 1) {
      throw new Error(`expected one row, got ${rows.length}`);
    }

    answer = Number(rows[0]);
  }
}

/*
 * ⚠️ PRINTED AFTER THE LOOP, OUTSIDE THE MEASURED WORK — a profiling SUBJECT that prints nothing is
 * indistinguishable from one that silently did nothing (item 2244's smoke test flagged exactly that). One
 * line naming the arm, the rep count and the ANSWER makes a no-op run visible.
 */
console.log(`  arm=${ARM} reps=${ARM === 'load' ? 0 : REPS} vertices=${N} answer=${answer}`);
