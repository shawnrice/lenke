/*
 * Item 2097 — is `walkBothSegment`'s cost the 3-DEEP `yield*` GENERATOR CHAIN?
 *
 * ⚠️ WHAT IS ALREADY CLOSED, so this does not re-derive it: the matcher's per-row Binding Map copy
 * (28.5% self + 24% GC) had a no-copy VIEW built at item 2023 and a REUSED map at 2024, both priced
 * and REFUSED. And `withBinding` short-circuits on an anonymous name (`if (!name) return binding`), so
 * `[:E]` costs it nothing.
 *
 * 🔑 WHAT IS LEFT: `walkSegments`/`walkBothSegment` recurse by `yield* walkSegments(...)` once PER
 * EDGE, so every row of a three-segment pattern is handed up through THREE generator frames. Item
 * 2096 showed the shape emits 1.6M rows at 1.2 µs each against the directed walk's 0.7 — and
 * [[gremlin-values-is-the-floor]] records the same mechanism on the other engine: "the reduce is free;
 * the cost is the generator chain."
 *
 * ⚠️ THE ARMS PRODUCE THE SAME ROWS IN THE SAME ORDER and the count is asserted, so an arm that
 * flattened the traversal differently would fail rather than look fast.
 */
const DEPTH = Number(process.env.DEPTH ?? 3);
const FANOUT = Number(process.env.FANOUT ?? 8);
const ROOTS = Number(process.env.ROOTS ?? 3200);
const REPS = Number(process.env.REPS ?? 11);

/* A tree: ROOTS roots, each node with FANOUT children, DEPTH deep. Rows = ROOTS * FANOUT^DEPTH. */
const EXPECTED = ROOTS * FANOUT ** DEPTH;

/** Nested `yield*` — one generator frame per level, which is what the engine does. */
const nested = function* (level, value) {
  if (level === DEPTH) {
    yield value;

    return;
  }

  for (let i = 0; i < FANOUT; i += 1) {
    yield* nested(level + 1, value * 31 + i);
  }
};

const arms = {
  // THE ENGINE'S SHAPE: a generator per level, delegated with `yield*`.
  genchain: () => {
    let sink = 0;
    let rows = 0;

    for (let r = 0; r < ROOTS; r += 1) {
      for (const v of nested(0, r)) {
        sink += v & 7;
        rows += 1;
      }
    }

    return { rows, sink };
  },
  /*
   * ⚠️ ONE generator, an EXPLICIT STACK instead of recursion — the same rows, the same order, but the
   * value crosses ONE frame instead of DEPTH.
   */
  onegen: () => {
    const flat = function* () {
      const stack = new Array(DEPTH + 1);
      const idx = new Array(DEPTH + 1);

      for (let r = 0; r < ROOTS; r += 1) {
        let level = 0;

        stack[0] = r;
        idx[0] = 0;

        while (level >= 0) {
          if (level === DEPTH) {
            yield stack[level];
            level -= 1;
            continue;
          }

          if (idx[level] >= FANOUT) {
            level -= 1;
            continue;
          }

          const i = idx[level];

          idx[level] += 1;
          stack[level + 1] = stack[level] * 31 + i;
          idx[level + 1] = 0;
          level += 1;
        }
      }
    };

    let sink = 0;
    let rows = 0;

    for (const v of flat()) {
      sink += v & 7;
      rows += 1;
    }

    return { rows, sink };
  },
  // ⚠️ THE FLOOR: no generator at all, a callback. Bounds what removing the chain could reach.
  callback: () => {
    let sink = 0;
    let rows = 0;
    const emit = (v) => {
      sink += v & 7;
      rows += 1;
    };
    const walk = (level, value) => {
      if (level === DEPTH) {
        emit(value);

        return;
      }

      for (let i = 0; i < FANOUT; i += 1) {
        walk(level + 1, value * 31 + i);
      }
    };

    for (let r = 0; r < ROOTS; r += 1) {
      walk(0, r);
    }

    return { rows, sink };
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

const ref = arms.callback();

arms[arm]();

const series = [];
let got = { rows: 0, sink: 0 };

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  got = arms[arm]();
  series.push(performance.now() - t0);
}

if (got.rows !== EXPECTED || got.sink !== ref.sink) {
  throw new Error(
    `${arm}: rows=${got.rows} (expected ${EXPECTED}) sink=${got.sink} (expected ${ref.sink}) — arms are not equivalent`,
  );
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  `${arm.padEnd(9)} median=${median.toFixed(2)} ms  ${((median * 1e6) / got.rows).toFixed(1)} ns/row  rows=${got.rows}`,
);
