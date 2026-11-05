/**
 * WHERE DOES `V().has(k, pred).count()` SPEND ITS 11.5 ns A VERTEX?
 *
 * Item 234 measured the shape three ways — the traverser pipeline at 38.2 ns a vertex, a
 * hand-written tally at 11.5, and "the scan alone, touching no property" at 4.6 — and shipped the
 * tally (`propertyCount` in `gremlin/src/executor/count-shortcut.ts`). That closed 3.3x and left
 * **2.5x between the tally and the floor unexplained**, which is the largest unaccounted gap in
 * this corpus's own numbers.
 *
 * Item 1491's profile is why it is worth decomposing now: `propertyCount` is 70.2% of the arm, and
 * a frame that large is either the work or the target, with nothing in between. Its shares say
 * `matches` + the comparators are ~15% and `get properties` ~10%, which leaves most of the 6.9 ns
 * inside the loop itself — unattributed.
 *
 * ⚠️ EACH ARM ADDS EXACTLY ONE THING to the one above it, so a difference names its own cause.
 * Every arm returns the SAME COUNT and the probe throws if they disagree — an arm that skips work
 * by answering a different question is the failure mode four separate items in this corpus have hit
 * (chain count 1479, values walk 1480/1483, presence count 1485, hop-count 1488).
 *
 *     NODES=200000 REPS=200 node tally-floor-probe.mjs
 *     ARM=engine PROF_OUT=/tmp/x.cpuprofile node tally-floor-probe.mjs
 */
import { Graph } from '@lenke/core';
import { V, count, gt, has, toArray, traversal } from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 200);
const DROP = Number(process.env.DROP ?? 5);
const CUT = Number(process.env.CUT ?? 3600);
const ONLY = process.env.ARM;

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    // `num` spans 4000 values and the cut keeps a tenth, matching `temporal-probe.mjs`'s fixture so
    // the two probes' readings are comparable.
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { num: i % 4000, k: i % 97 } });
  }

  return g;
};

const graph = build();
const plan = traversal(V(), has('num', gt(CUT)), count());

const ARMS = {
  // 1. The Map walk and nothing else. Item 234's "scan alone, touching no property" — except it
  //    must still produce the same answer, so it counts a constant instead of a predicate. The
  //    count is wrong by construction, so this arm is EXCLUDED from the agreement check and is a
  //    cost floor only.
  scan: () => {
    let n = 0;

    for (const _v of graph.verticesById.values()) {
      n += 1;
    }

    return n;
  },

  // 2. + the `properties` getter, per vertex. Nothing is read out of it.
  getter: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      if (v.properties !== undefined) {
        n += 1;
      }
    }

    return n;
  },

  // 3. + the keyed read. Still no comparison.
  read: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      if (v.properties.num !== undefined) {
        n += 1;
      }
    }

    return n;
  },

  // 4. + an INLINE comparison — the honest floor for the real question, and the arm whose count
  //    must match the engine's.
  inline: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      const x = v.properties.num;

      if (typeof x === 'number' && x > CUT) {
        n += 1;
      }
    }

    return n;
  },

  // 5. + a DYNAMIC key, which is what the engine has (`step.key` is not a literal). Isolates the
  //    cost of `properties[key]` against `properties.num`, a megamorphic-access question that the
  //    inline arm's literal cannot see.
  dynkey: () => {
    const key = 'num';
    let n = 0;

    for (const v of graph.verticesById.values()) {
      const x = v.properties[key];

      if (typeof x === 'number' && x > CUT) {
        n += 1;
      }
    }

    return n;
  },

  // 6. + a CLOSURE per comparison instead of inline code — the shape a specialized predicate would
  //    take, so this prices the specialization BEFORE it is built. If this arm sits at the engine's
  //    reading rather than the inline one, specializing `matches` cannot pay.
  closure: () => {
    const key = 'num';
    const pred = (x) => typeof x === 'number' && x > CUT;
    let n = 0;

    for (const v of graph.verticesById.values()) {
      if (pred(v.properties[key])) {
        n += 1;
      }
    }

    return n;
  },

  // 7. The engine.
  engine: () => {
    const out = toArray(plan, graph);

    return Array.isArray(out) ? out[0] : out;
  },
};

/** Arms whose answer must agree; `scan` and `getter` and `read` count every vertex by design. */
const CHECKED = new Set(['inline', 'dynkey', 'closure', 'engine']);

const names = ONLY === undefined ? Object.keys(ARMS) : [ONLY];

for (const n of names) {
  if (ARMS[n] === undefined) {
    throw new Error(`unknown ARM ${n}; have ${Object.keys(ARMS).join(',')}`);
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const results = [];

for (const name of names) {
  const r = await profileWindow(process.env.PROF_OUT, () => {
    const reps = [];
    let answer = 0;

    for (let i = 0; i < REPS; i += 1) {
      const t0 = performance.now();

      answer = ARMS[name]();
      reps.push(performance.now() - t0);
    }

    return { ms: med(reps.slice(DROP)), answer };
  });

  results.push({ name, ...r });
}

const checked = results.filter((r) => CHECKED.has(r.name));

if (checked.length > 1) {
  const [first] = checked;

  for (const r of checked.slice(1)) {
    if (r.answer !== first.answer) {
      throw new Error(
        `ARMS DISAGREE — ${first.name}=${first.answer} but ${r.name}=${r.answer}. ` +
          `One of them is answering a different question, so no ratio below is meaningful.`,
      );
    }
  }
}

console.log(`\nTALLY FLOOR — NODES=${NODES} REPS=${REPS} DROP=${DROP} CUT=${CUT}\n`);
console.log(
  `${'arm'.padEnd(9)}${'ms'.padStart(8)}${'ns/vertex'.padStart(11)}${'vs scan'.padStart(9)}  answer`,
);

const base = results.find((r) => r.name === 'scan')?.ms;

for (const r of results) {
  const ns = ((r.ms * 1e6) / NODES).toFixed(2);
  const rel = base === undefined ? '' : `${(r.ms / base).toFixed(2)}x`;

  console.log(
    `${r.name.padEnd(9)}${r.ms.toFixed(2).padStart(8)}${ns.padStart(11)}${rel.padStart(9)}  ${r.answer}${CHECKED.has(r.name) ? '' : '  (unchecked)'}`,
  );
}

console.log();
