/*
 * Item 2098 — what would a LAZY-iterator-with-`drain` `store` arm be worth, and what does it risk?
 *
 * ⚠️ WHAT IS SETTLED. Item 2070 refused `store` in the `[bag]` residual and has a mutant that CATCHES
 * admitting it. The reason is exact: `barrierProjectedBag` **returns the drained array**, so admitting
 * `store` there makes the result eager for EVERY consumer — and `run` is the public lazy API, so a
 * caller that `break`s out would have caused elements to be collected that it never pulled.
 *
 * 🔑 WHAT IS NOT COVERED BY THAT REFUSAL. `toArray`'s own rule (item 1412) is "an already-eager
 * terminal takes an eager walk… `run` is left exactly as lazy as it was". A result that is LAZY as an
 * iterator and ALSO offers `drain` satisfies both: the breaking caller takes the iterator and collects
 * only what it pulled; `toArray` takes `drain` and collects everything, which is what it does anyway.
 *
 * ⚠️⚠️ AND THE HAZARD THIS PROBE EXISTS TO SHOW. A side-effecting LAZY walk is STATEFUL in a way the
 * array form is not: the bag must be filled EXACTLY ONCE. Iterate twice, or iterate and then drain,
 * and the bag DOUBLES — a silent wrong answer. The array form cannot do that. The arms below measure
 * the win AND demonstrate the hazard, so the record is actionable either way.
 */
const ROWS = Number(process.env.ROWS ?? 600000);
const REPS = Number(process.env.REPS ?? 11);

const values = new Array(ROWS);

for (let i = 0; i < ROWS; i += 1) {
  values[i] = i % 97;
}

/** The fused walk: a generator over the projected values, with an eager `drain`. */
const fusedWalk = () => {
  const walk = function* () {
    for (let i = 0; i < ROWS; i += 1) {
      yield values[i];
    }
  };
  const out = walk();

  out.drain = () => values.slice();

  return out;
};

const arms = {
  /*
   * THE GENERIC PATH, as item 2070 measured it: the bag step appended to a traverser stream. Modelled
   * as a per-element push through a wrapper generator, which is what `side-effects.ts` does.
   */
  generic: () => {
    const bag = [];
    const src = fusedWalk();
    const wrapped = (function* () {
      for (const v of src) {
        bag.push(v);

        yield v;
      }
    })();
    let n = 0;

    for (const v of wrapped) {
      n += v === -1 ? 1 : 0;
    }

    return { n, bag: bag.length };
  },
  /*
   * ⚠️ THE EAGER FORM ITEM 2070 REFUSED, measured only as a CEILING — it is what `aggregate` gets and
   * what `store` may not have, because the array it returns is eager for every consumer.
   */
  eager: () => {
    const bag = [];
    const drained = fusedWalk().drain();

    for (const v of drained) {
      bag.push(v);
    }

    let n = 0;

    for (const v of drained) {
      n += v === -1 ? 1 : 0;
    }

    return { n, bag: bag.length };
  },
  /*
   * 🔑 THE PROPOSAL: lazy as an iterator, eager via `drain`. `toArray` takes the drain, so this arm
   * measures what the common path would cost.
   */
  lazydrain: () => {
    const bag = [];
    const src = fusedWalk();
    const result = {
      [Symbol.iterator]: function* () {
        for (const v of src) {
          bag.push(v);

          yield v;
        }
      },
      drain: () => {
        const all = src.drain();

        for (const v of all) {
          bag.push(v);
        }

        return all;
      },
    };
    // `toArray`'s route.
    const rows = result.drain();
    let n = 0;

    for (const v of rows) {
      n += v === -1 ? 1 : 0;
    }

    return { n, bag: bag.length };
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

arms[arm]();

const series = [];
let got = { n: 0, bag: 0 };

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  got = arms[arm]();
  series.push(performance.now() - t0);
}

// ⚠️ THE BAG MUST HOLD EXACTLY ONE COPY. An arm that double-filled it would otherwise look like a
// faster arm with the same row count.
if (got.bag !== ROWS) {
  throw new Error(
    `${arm}: bag holds ${got.bag}, expected exactly ${ROWS} — double-filled or short`,
  );
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  `${arm.padEnd(10)} median=${median.toFixed(2)} ms  ${((median * 1e6) / ROWS).toFixed(1)} ns/row  bag=${got.bag}`,
);
