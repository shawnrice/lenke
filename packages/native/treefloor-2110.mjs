/*
 * Item 2110 — is `tree()`'s cost the NULL-PROTOTYPE DICTIONARY, or the keying?
 *
 * WHERE THE 754 ms GOES, from the profile (3 rounds, fixture subtracted by inspection):
 *   - `memoizedTreeKey` ~26% — and the memo is PERFECT: 90% hit rate, misses exactly 1.00x the
 *     distinct-vertex count, so identity keying is doing its job.
 *   - the insert `forEach` ~37% — whose per-row closure lever item 1925 measured at 2% and REFUTED.
 *
 * SO THE UNEXPLORED PIECE IS `cursor[key]` ITSELF. The tree is nested `Object.create(null)` records
 * and the root gets **200,000 distinct string keys**. V8 moves such an object to DICTIONARY MODE, where
 * a property access is far dearer than a `Map.get` — and `ts-set-is-o-width` already records a
 * dictionary-mode cliff in this repo at 128→256 keys.
 *
 * THIS IS A FLOOR, NOT A PROPOSAL. It prices four containers on the SAME synthetic work so the
 * answer is attributable before any engine code changes. If the null-proto object is not the cost, the
 * lever does not exist and this records that; if it is, the engine's own constraint still applies —
 * `tree()` RETURNS the nested object to the caller and its reserved-key handling is settled
 * (`prototype-key-class-not-a-bug`), so a `Map` build would need a conversion pass whose cost is
 * measured here too.
 *
 * KEYS ARE THE REAL SHAPE: `treeKey` is `JSON.stringify(node.toJSON())`, so they are LONG strings,
 * not short ids. Short keys would hash differently and flatter every container equally.
 */
const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);

/** Long keys, as `JSON.stringify(vertex.toJSON())` produces. */
const keys = [];

for (let i = 0; i < N; i += 1) {
  keys.push(`{"id":"v${i}","labels":["P"],"properties":{"n":${i % 97},"k":"k${i % 1000}"}}`);
}

/* The path pairs the real walk produces: a near end and a far end, FANOUT far ends per near end. */
const pairs = [];

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    pairs.push([i, (i * 7 + 3 + d * 104_729) % N]);
  }
}

/*
 * HOISTED to module scope, not written inside the arm: a closure recreated per call would be a cost
 * the OTHER arms do not pay, and this file's whole job is to make the four comparable.
 */
const toObj = (m) => {
  const o = Object.create(null);

  for (const [k, v] of m) {
    o[k] = toObj(v);
  }

  return o;
};

const arms = {
  /* THE ENGINE'S SHAPE: nested null-prototype records. */
  nullproto: () => {
    const root = Object.create(null);

    for (const [a, b] of pairs) {
      let cursor = root;

      for (const idx of [a, b]) {
        const key = keys[idx];
        let next = cursor[key];

        if (!next) {
          next = Object.create(null);
          cursor[key] = next;
        }

        cursor = next;
      }
    }

    return Object.keys(root).length;
  },
  /* A PLAIN object, to separate "null prototype" from "dictionary mode". */
  plainobj: () => {
    const root = {};

    for (const [a, b] of pairs) {
      let cursor = root;

      for (const idx of [a, b]) {
        const key = keys[idx];
        let next = cursor[key];

        if (!next) {
          next = {};
          cursor[key] = next;
        }

        cursor = next;
      }
    }

    return Object.keys(root).length;
  },
  /* NESTED MAPS — the hypothesis. */
  maps: () => {
    const root = new Map();

    for (const [a, b] of pairs) {
      let cursor = root;

      for (const idx of [a, b]) {
        const key = keys[idx];
        let next = cursor.get(key);

        if (next === undefined) {
          next = new Map();
          cursor.set(key, next);
        }

        cursor = next;
      }
    }

    return root.size;
  },
  /* MAPS PLUS THE CONVERSION the engine would owe its caller — the honest total. */
  mapsconv: () => {
    const root = new Map();

    for (const [a, b] of pairs) {
      let cursor = root;

      for (const idx of [a, b]) {
        const key = keys[idx];
        let next = cursor.get(key);

        if (next === undefined) {
          next = new Map();
          cursor.set(key, next);
        }

        cursor = next;
      }
    }

    return Object.keys(toObj(root)).length;
  },
};

console.log(`  N=${N} FANOUT=${FANOUT} paths=${pairs.length}, median of ${REPS}\n`);

for (const [name, fn] of Object.entries(arms)) {
  const series = [];
  let got = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    got = fn();
    series.push(performance.now() - t0);
  }

  const kept = series.slice(2).sort((a, b) => a - b);

  // Every arm must build the SAME tree, or the comparison is of different trees.
  if (got !== N) {
    throw new Error(`${name}: root has ${got} entries, expected ${N}`);
  }

  console.log(
    `  ${name.padEnd(10)} ${kept[Math.floor(kept.length / 2)].toFixed(1).padStart(8)} ms   ${((kept[Math.floor(kept.length / 2)] * 1e6) / pairs.length).toFixed(0).padStart(5)} ns/path`,
  );
}
