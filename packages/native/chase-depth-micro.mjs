/**
 * DOES DEPENDENT-LOAD DEPTH EXPLAIN ITEM 1770's 60 ns/row? (item 1771)
 *
 * Item 1770 measured `far.properties[valueKey]` at 60 of the ~80 ns/row of
 * `V().out(T).values(k)` — a 4.0x ceiling — and refuted FIVE mechanisms for it: not deopts, not GC,
 * not the freeze (1.45 vs 1.47 ns), not the variable key (1.45 vs 1.44), not a stale per-instance
 * box (the walk yields canonical instances, 10,000 of 10,000), and not locality alone (200,000 bags
 * in random order reads 3.5 ns, still 17x short).
 *
 * It left ONE hypothesis, explicitly untested and explicitly not to be built against: the micro
 * chases ONE pointer where the walk chases several —
 *
 *     edge  ->  .to getter  ->  Vertex  ->  #box  ->  bag  ->  [key]
 *
 * This micro varies ONLY that depth. Every arm reads the same 200,000 values in the same random
 * order and returns the same sum; they differ only in how many dependent loads stand between the
 * index and the number. If depth is the mechanism, cost rises per level and depth 4-5 lands near
 * 60 ns. If it does not, the hypothesis is dead and item 1770's ceiling needs a sixth candidate.
 *
 * ⚠️ ALL LEVELS FOR ONE ELEMENT ARE ALLOCATED TOGETHER, interleaved across elements. Allocating all
 * bags and then all holders would give each arm a DIFFERENT heap layout, so the comparison would be
 * locality-vs-depth rather than depth alone — and item 1770 already showed locality is worth 2.4x
 * here, which is easily enough to fake this result. Interleaving also matches the engine, where a
 * Vertex and its box are created together.
 *
 * ⚠️ AND THE ANSWER IS ASSERTED PER ARM against a sum computed from the data: an arm that chased to
 * the wrong place would otherwise be a fast reading rather than a failure.
 */
const N = Number(process.env.N ?? 2_000_000);
const REPS = Number(process.env.REPS ?? 9);
const COUNT = Number(process.env.COUNT ?? 200_000);

const d1 = new Array(COUNT); // bag
const d2 = new Array(COUNT); // holder -> bag
const d3 = new Array(COUNT); // holder -> box -> bag
const d4 = new Array(COUNT); // edge -> vertex -> box -> bag
const d5 = new Array(COUNT); // edge -> vertex -> box -> bag, with the vertex behind a getter

/** One prototype, one accessor — the shape `Edge`/`Vertex` actually have. */
class EdgeLike {
  #to;

  constructor(to) {
    this.#to = to;
  }

  get to() {
    return this.#to;
  }
}

/**
 * ⚠️ ALLOCATION ORDER IS NOW A VARIABLE, and item 1773 is why. Interleaving every level of one
 * element was chosen to stop heap layout differing BETWEEN arms — but it also colocates a holder,
 * its box and its bag into neighbouring cache lines, which removes the very effect depth was being
 * tested for. The engine does NOT allocate that way: a box is created by `Graph` and its bag comes
 * from `normalizeProperties`, at different moments, with other objects in between.
 *
 *   ALLOC=interleaved   all levels of element i allocated together   (item 1771's original)
 *   ALLOC=scattered     each level allocated in its own pass         (the engine's shape)
 *
 * Holding the arms' SHAPES identical and varying only this is what separates "depth is free" from
 * "depth is free WHEN COLOCATED".
 */
const ALLOC = process.env.ALLOC ?? 'interleaved';
const bagsFor = () => {
  const out = new Array(COUNT);

  for (let i = 0; i < COUNT; i += 1) {
    out[i] = Object.freeze({ age: 20 + (i % 60), name: `n${i}` });
  }

  return out;
};

// In scattered mode every level is a separate allocation pass, so an element's levels end up far
// apart; in interleaved mode these stay unused and the per-element loop below allocates instead.
const sBags = ALLOC === 'scattered' ? Array.from({ length: 5 }, bagsFor) : undefined;
const sBoxes =
  ALLOC === 'scattered'
    ? [
        sBags[2].map((bag) => ({ bag })),
        sBags[3].map((bag) => ({ bag })),
        sBags[4].map((bag) => ({ bag })),
      ]
    : undefined;
const sVerts =
  ALLOC === 'scattered'
    ? [sBoxes[1].map((box) => ({ box })), sBoxes[2].map((box) => ({ box }))]
    : undefined;

for (let i = 0; i < COUNT; i += 1) {
  const age = 20 + (i % 60);

  // One bag per element, built by assignment and frozen, as `normalizeProperties` leaves it.
  const bag1 = Object.freeze({ age, name: `n${i}` });
  const bag2 = Object.freeze({ age, name: `n${i}` });
  const bag3 = Object.freeze({ age, name: `n${i}` });
  const bag4 = Object.freeze({ age, name: `n${i}` });
  const bag5 = Object.freeze({ age, name: `n${i}` });

  d1[i] = bag1;
  d2[i] = { bag: bag2 };
  d3[i] = { box: { bag: bag3 } };

  const vertex4 = { box: { bag: bag4 } };

  d4[i] = { to: vertex4 };

  // Depth 4 + accessor: the vertex sits behind a GETTER, which is what `edge.to` and
  // `vertex.properties` actually are — a getter, not a field.
  //
  // ⚠️ THE GETTER MUST LIVE ON A SHARED PROTOTYPE, and the first version of this arm got that
  // wrong. Writing `{ get to() {…} }` per element creates 200,000 DISTINCT accessor closures, so
  // the call site goes megamorphic and the arm measured 158.29 ns — 9.1x the whole chase, and a
  // worse number than the engine it was modelling, which is what gave it away. `Edge.prototype`
  // has ONE `to` getter shared by every edge, so the class form below is the faithful model.
  d5[i] = new EdgeLike({ box: { bag: bag5 } });
}

if (ALLOC === 'scattered') {
  for (let i = 0; i < COUNT; i += 1) {
    d1[i] = sBags[0][i];
    d2[i] = { bag: sBags[1][i] };
    d3[i] = { box: sBoxes[0][i] };
    d4[i] = { to: sVerts[0][i] };
    d5[i] = new EdgeLike(sVerts[1][i]);
  }
}

// A fixed permutation, built once outside every timed loop.
const idx = new Int32Array(COUNT);

for (let i = 0; i < COUNT; i += 1) {
  idx[i] = i;
}

let seed = 987_654_321;

for (let i = COUNT - 1; i > 0; i -= 1) {
  // ⚠️ A 32-bit-safe LCG. CLAUDE.md records an f64 LCG whose period collapsed from 2^31 to ~11k
  // draws because `s * 1103515245` passes 2^53 — the defect that made a degenerate fixture read
  // 14x fast. `Math.imul` keeps the multiply in 32 bits.
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;

  const j = seed % (i + 1);
  const t = idx[i];

  idx[i] = idx[j];
  idx[j] = t;
}

// The key is read from an array so V8 cannot fold it to a constant — the walk's `valueKey` is a
// closure variable, and item 1770 showed constancy is worth nothing here anyway.
const keyBox = ['age'];

const ARMS = {
  'depth 1  bag[k]': () => {
    const a = d1;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % COUNT]][k];
    }

    return s;
  },
  'depth 2  .bag[k]': () => {
    const a = d2;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % COUNT]].bag[k];
    }

    return s;
  },
  'depth 3  .box.bag[k]': () => {
    const a = d3;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % COUNT]].box.bag[k];
    }

    return s;
  },
  'depth 4  .to.box.bag[k]': () => {
    const a = d4;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % COUNT]].to.box.bag[k];
    }

    return s;
  },
  'depth 4 + proto getter': () => {
    const a = d5;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % COUNT]].to.box.bag[k];
    }

    return s;
  },
};

let want = 0;

for (let i = 0; i < N; i += 1) {
  want += d1[idx[i % COUNT]].age;
}

const out = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    const got = fn();

    series.push(performance.now() - t);

    if (got !== want) {
      throw new Error(`${name}: sum ${got} !== ${want} — chased to the wrong place`);
    }
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out[name] = {
    nsPerRead: Number(((kept[Math.floor(kept.length / 2)] * 1e6) / N).toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  };
}

console.log(JSON.stringify({ n: N, count: COUNT, arms: out }, null, 2));
