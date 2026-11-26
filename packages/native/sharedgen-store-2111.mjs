/*
 * Item 2111 — can `store`'s lazy arm be sound WITHOUT the single-use latch item 2098 called a blocker?
 *
 * WHAT 2098 ESTABLISHED. Item 2070's `store` refusal is correct for the EAGER form (`barrierProjectedBag`
 * returns the drained array, so admitting `store` there makes the result eager for every consumer). A
 * LAZY-iterator-plus-`drain` arm is sound against that rule and measured **~2.1x** on the bag term. But
 * it DOUBLED the bag on iterate-then-drain, and the entry concluded: "A fix needs a single-use latch,
 * which is new statefulness in a hot path whose failure mode is a wrong answer in a side-effect bag."
 *
 * **THAT CONCLUSION IS A CLAIM ABOUT THE DESIGN, NOT ABOUT LAZINESS** — the discipline is to separate
 * a TECHNICAL blocker from a policy one. 2098's arm has the iterator walk `src` and `drain()` call
 * `src.drain()`, pushing to the bag from TWO independent paths; an element pulled by both is pushed
 * twice. That is a bug in that arm, not a property of lazy side effects.
 *
 * THE DESIGN UNDER TEST: ONE generator, shared. The iterator and `drain` both pull the SAME generator,
 * so the generator's OWN existing state — not a new latch — makes each element yield exactly once. Then
 * iterate-then-drain gives the iterated prefix once and the remainder once, totalling exactly ROWS.
 *
 * FOUR CONSUMPTION PATTERNS, AND EVERY ONE ASSERTS `bag.length === ROWS`:
 *   - drain only              (`toArray`'s route)
 *   - iterate fully           (`run` consumed to the end)
 *   - iterate PART-WAY only   (the `break`ing caller the refusal exists to protect)
 *   - iterate part-way THEN drain  (2098's demonstrated doubling)
 *
 * A PART-WAY ITERATION MUST BAG ONLY WHAT IT PULLED. That is the whole point of the refusal, so it is
 * asserted separately rather than folded into the others.
 */
const ROWS = Number(process.env.ROWS ?? 300000);
const REPS = Number(process.env.REPS ?? 9);
const BREAK_AT = Number(process.env.BREAK_AT ?? 1000);

/*
 * A STAND-IN FOR THE FUSED WALK, deliberately: this prices the BAG TERM and the correctness of the
 * consumption protocol, not the engine's walk. Item 2098's floor did the same and its numbers are the
 * ones this is comparable to. A generator with a `drain` that slices is exactly the shape the engine's
 * fused walks expose.
 */
const fusedWalk = () => {
  let i = 0;
  const gen = (function* () {
    while (i < ROWS) {
      yield i;
      i += 1;
    }
  })();

  return {
    [Symbol.iterator]: () => gen,
    /* `drain` must respect what the generator already yielded, or it is 2098's bug again. */
    drain: () => {
      const out = [];

      for (const v of gen) {
        out.push(v);
      }

      return out;
    },
  };
};

const arms = {
  /** What `store` does today: a generic per-element push through the step machinery. */
  generic: () => {
    const bag = [];
    const src = fusedWalk();
    const rows = [];

    for (const v of src) {
      bag.push(v);
      rows.push(v);
    }

    return { rows: rows.length, bag: bag.length };
  },
  /** The EAGER form item 2070 refused — what `aggregate` gets. */
  eager: () => {
    const bag = [];
    const all = fusedWalk().drain();

    for (const v of all) {
      bag.push(v);
    }

    return { rows: all.length, bag: bag.length };
  },
  /** THE PROPOSAL, drained — `toArray`'s route. */
  shared_drain: () => {
    const { result, bag } = sharedStore();
    const rows = result.drain();

    return { rows: rows.length, bag: bag.length };
  },
  /** THE PROPOSAL, iterated to the end — `run` consumed fully. */
  shared_iter: () => {
    const { result, bag } = sharedStore();
    let n = 0;

    for (const _ of result) {
      n += 1;
    }

    return { rows: n, bag: bag.length };
  },
};

/**
 * The proposal: ONE generator behind both the iterator and `drain`.
 *
 * NO LATCH, NO FLAG, NO COUNTER. `gen` is consumed by whichever path pulls it, and a generator cannot
 * yield the same element twice — so "exactly once" is the generator's own guarantee rather than new
 * state this code has to maintain. That is the whole difference from item 2098's arm, which walked the
 * source from the iterator and called `src.drain()` from `drain`, pushing to the bag from two
 * independent paths.
 */
const sharedStore = () => {
  const bag = [];
  const src = fusedWalk();
  const gen = src[Symbol.iterator]();
  const result = {
    [Symbol.iterator]: function* () {
      for (let step = gen.next(); step.done !== true; step = gen.next()) {
        bag.push(step.value);

        yield step.value;
      }
    },
    drain: () => {
      const out = [];

      for (let step = gen.next(); step.done !== true; step = gen.next()) {
        bag.push(step.value);
        out.push(step.value);
      }

      return out;
    },
  };

  return { result, bag };
};

/* ===== CORRECTNESS FIRST. A faster arm that double-fills the bag is a wrong answer, not a win. ===== */
console.log(`  ROWS=${ROWS}  BREAK_AT=${BREAK_AT}\n  CORRECTNESS`);

{
  const { result, bag } = sharedStore();
  const rows = result.drain();

  console.log(
    `    drain only            rows=${rows.length} bag=${bag.length} ${bag.length === ROWS ? 'OK' : 'WRONG'}`,
  );
}

{
  const { result, bag } = sharedStore();
  let n = 0;

  for (const _ of result) {
    n += 1;
  }

  console.log(
    `    iterate fully         rows=${n} bag=${bag.length} ${bag.length === ROWS ? 'OK' : 'WRONG'}`,
  );
}

{
  const { result, bag } = sharedStore();
  let n = 0;

  for (const _ of result) {
    n += 1;

    if (n >= BREAK_AT) {
      break;
    }
  }

  // THE BREAKING CALLER: the bag must hold ONLY what was pulled — the refusal's whole purpose.
  console.log(
    `    iterate part-way      rows=${n} bag=${bag.length} ${bag.length === BREAK_AT ? 'OK (only what it pulled)' : 'WRONG'}`,
  );
}

{
  const { result, bag } = sharedStore();
  let n = 0;

  for (const _ of result) {
    n += 1;

    if (n >= BREAK_AT) {
      break;
    }
  }

  const rest = result.drain();

  // ITEM 2098's DEMONSTRATED DOUBLING. Exactly ROWS total, or the design is no better than its arm.
  console.log(
    `    part-way THEN drain   pulled=${n} drained=${rest.length} bag=${bag.length} ${bag.length === ROWS ? 'OK (no doubling, no latch)' : 'WRONG — DOUBLED'}`,
  );
}

/* ===== THEN THE PRICE. ===== */
console.log('\n  PRICE');

for (const [name, fn] of Object.entries(arms)) {
  const series = [];
  let got = { rows: 0, bag: 0 };

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    got = fn();
    series.push(performance.now() - t0);
  }

  if (got.bag !== ROWS || got.rows !== ROWS) {
    throw new Error(`${name}: rows=${got.rows} bag=${got.bag}, expected ${ROWS} of each`);
  }

  const kept = series.slice(3).sort((a, b) => a - b);
  const median = kept[Math.floor(kept.length / 2)];

  console.log(
    `    ${name.padEnd(14)} ${median.toFixed(2).padStart(7)} ms   ${((median * 1e6) / ROWS).toFixed(1).padStart(6)} ns/row`,
  );
}
