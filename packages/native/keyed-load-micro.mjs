/**
 * WHY IS `far.properties[valueKey]` 4.0x OF A GREMLIN VALUES WALK? (item 1770)
 *
 * Item 1770's ablation put the per-row property read at 4.0x of the fast mode and 7.0x of the slow
 * one, and showed the walk's 1.77x process bimodality VANISHES without it (ablated spread 1.11x
 * across eight processes). So the keyed load is the dominant cost of `V().out(T).values(k)` and the
 * cause of the mode lottery. This micro asks which property of the load is responsible, because the
 * two obvious culprits have different answers in this repo:
 *
 *   - **A FROZEN bag.** `Vertex.properties` hands back the graph's live object, frozen. Item 1734
 *     already refuted "the freeze costs the later reads" — but it tested a hoisted bag read with
 *     CONSTANT keys, which is a different load shape from this one.
 *   - **A VARIABLE key.** Item 1450 found "the whole win came from CONSTANT property keys". A
 *     closure-captured `valueKey` cannot use a constant-key inline cache. ⚠️ If that is the cause,
 *     the win is UNREACHABLE rather than pending: specializing on a literal key needs runtime
 *     codegen, which `no-runtime-codegen` forbids outright (it forces `unsafe-eval` into every
 *     embedder's CSP).
 *
 * The arms cross those two factors, so the result says which one to chase — and whether either is
 * worth chasing at all.
 *
 * ⚠️ THE KEY IS READ FROM AN ARRAY, not a literal, in the "variable" arms. Writing `o[k]` where `k`
 * is a `const` in scope lets V8 treat it as a constant anyway, which would measure the wrong thing.
 */
const N = Number(process.env.N ?? 2_000_000);
const REPS = Number(process.env.REPS ?? 9);
const KEYS = Number(process.env.KEYS ?? 2);

// Bags shaped like the engine's: a handful of string keys, built by assignment (not a literal), so
// the hidden class is reached the way `normalizeProperties` reaches it.
const makeBag = (i, freeze) => {
  const o = {};

  o.age = 20 + (i % 60);
  o.name = `n${i}`;

  for (let k = 2; k < KEYS; k += 1) {
    o[`k${k}`] = k;
  }

  return freeze ? Object.freeze(o) : o;
};

const COUNT = Number(process.env.COUNT ?? 20_000);
// ⚠️ RANDOM order when asked: the walk reads bags in ADJACENCY order, effectively random across the
// heap, where a sequential sweep is cache-friendly. Item 1770 found that distinction to be the
// whole effect, so the probe must be able to express both.
const ORDER = process.env.ORDER ?? 'seq';
const frozen = Array.from({ length: COUNT }, (_, i) => makeBag(i, true));
const plain = Array.from({ length: COUNT }, (_, i) => makeBag(i, false));

// The variable key, held where V8 cannot fold it to a constant.
const keyBox = ['age'];

// A fixed permutation, built once outside every timed loop, so the access ORDER is the only thing
// that differs between the seq and rand runs — not the work of computing an index.
const idx = new Int32Array(COUNT);

for (let i = 0; i < COUNT; i += 1) {
  idx[i] = i;
}

if (ORDER === 'rand') {
  let seed = 12_345;

  for (let i = COUNT - 1; i > 0; i -= 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = seed % (i + 1);
    const t = idx[i];

    idx[i] = idx[j];
    idx[j] = t;
  }
}

const ARMS = {
  'frozen + variable key': () => {
    const bags = frozen;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += bags[idx[i % COUNT]][k];
    }

    return s;
  },
  'plain + variable key': () => {
    const bags = plain;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += bags[idx[i % COUNT]][k];
    }

    return s;
  },
  'frozen + constant key': () => {
    const bags = frozen;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += bags[idx[i % COUNT]].age;
    }

    return s;
  },
  'plain + constant key': () => {
    const bags = plain;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += bags[idx[i % COUNT]].age;
    }

    return s;
  },
};

const out = {};
// The expected sum, computed once from the data rather than hard-coded: every arm must agree, or an
// arm that read the wrong key would be an answer-INEQUIVALENT fast reading (item 1749).
let want = 0;

for (let i = 0; i < N; i += 1) {
  want += frozen[idx[i % COUNT]].age;
}

for (const [name, fn] of Object.entries(ARMS)) {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    const got = fn();

    series.push(performance.now() - t);

    if (got !== want) {
      throw new Error(`${name}: sum ${got} !== ${want} — not answer-equivalent`);
    }
  }

  // Drop the first three reps as warm-up, take the median of the rest: CLAUDE.md's TS estimator.
  const kept = series.slice(3).sort((a, b) => a - b);

  out[name] = {
    nsPerRead: Number(((kept[Math.floor(kept.length / 2)] * 1e6) / N).toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  };
}

console.log(JSON.stringify({ n: N, keys: KEYS, arms: out }, null, 2));
