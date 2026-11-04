/**
 * Is `drainMutations`' duplicate-keeping `pendingTokens` array worth replacing with a count map?
 *
 * Item 1360 found `drainMutations` is the ONE unpriced engine frame in the write-path screen (3.0-4.0%
 * of three shapes), and reading it shows why: `pushTokens` appends one entry PER TOKEN PER WRITE with
 * duplicates kept, so `addVertex({labels:['P'], properties:{k,s,n}})` x 20,000 puts **80,000 entries**
 * in the array of which **4 are distinct**. The drain then walks all 80,000 doing `Map.get`+`Map.set`
 * on four keys, to land on `{P:20000, k:20000, s:20000, n:20000}`.
 *
 * The transform: accumulate `Map<string, number>` counts at push time, then add each count once.
 * Same final epoch numbers (a sum is a sum, and the counters are independent so order is free), with
 * the drain O(distinct) instead of O(writes) and no 80,000-element array to grow and collect.
 *
 * ⚠️ IT IS A TRADE, NOT A FREE WIN, which is the whole reason to measure instead of building: the push
 * side pays a hash `set` where it paid an array `push`. Few distinct tokens (one label, a narrow bag —
 * the common shape) should win big on the drain; ALL-DISTINCT tokens are the adversarial case and may
 * lose outright. Both arms are measured on both distributions, plus the GC each leaves behind.
 *
 * This is a MICRO, so read it as go/no-go only: item 1104 established that a probe whose working set
 * is smaller than the engine's UNDERSTATES the engine's cost (~28 ns against ~46). A positive here
 * earns the real in-engine A/B, nothing more.
 *
 *     node --expose-gc token-drain-probe.mjs
 */
const WRITES = 20_000;
const TOKENS_PER_WRITE = 4;
const REPS = 14;
const DROP = 3;

/** The engine's shape: one label plus three property keys, identical on every write. */
const narrow = () => ['P', 'k', 's', 'n'];

/** The adversarial shape: every write touches tokens nothing else does. */
const wide = (i) => [`L${i}`, `a${i}`, `b${i}`, `c${i}`];

/** TODAY: push every token, duplicates kept, then walk them all. */
const arrayArm = (gen) => {
  const epochs = new Map();
  let pending = [];

  for (let w = 0; w < WRITES; w += 1) {
    const toks = gen(w);

    for (let t = 0; t < TOKENS_PER_WRITE; t += 1) {
      pending.push(toks[t]);
    }
  }

  for (const token of pending) {
    epochs.set(token, (epochs.get(token) ?? 0) + 1);
  }

  pending = [];

  return epochs;
};

/** PROPOSED: tally at push time, then add each distinct count once. */
const mapArm = (gen) => {
  const epochs = new Map();
  let pending = new Map();

  for (let w = 0; w < WRITES; w += 1) {
    const toks = gen(w);

    for (let t = 0; t < TOKENS_PER_WRITE; t += 1) {
      const k = toks[t];

      pending.set(k, (pending.get(k) ?? 0) + 1);
    }
  }

  for (const [token, n] of pending) {
    epochs.set(token, (epochs.get(token) ?? 0) + n);
  }

  pending = new Map();

  return epochs;
};

/** EQUIVALENCE FIRST: a faster arm that lands on different numbers is not an arm. */
const checkSame = (gen, name) => {
  const a = arrayArm(gen);
  const b = mapArm(gen);

  if (a.size !== b.size) {
    throw new Error(`${name}: sizes differ ${a.size} vs ${b.size}`);
  }

  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      throw new Error(`${name}: ${k} -> ${v} vs ${b.get(k)}`);
    }
  }

  return a.size;
};

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);

  return s[Math.floor(s.length / 2)];
};

const time = (fn, gen) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const out = fn(gen);

    series.push(performance.now() - t0);

    if (out.size === 0) {
      throw new Error('empty result — measuring nothing');
    }
  }

  return { median: median(series.slice(DROP)), series };
};

// Objects rather than tuples: a mixed `[string, fn]` array infers `name` as `string | Function`,
// which `restrict-template-expressions` refuses in the report below.
for (const { name, gen } of [
  { name: 'narrow (4 distinct)', gen: narrow },
  { name: 'wide (all distinct)', gen: wide },
]) {
  const distinct = checkSame(gen, name);
  // Order alternated per distribution so neither arm always runs on a colder heap.
  const first = time(arrayArm, gen);
  const second = time(mapArm, gen);
  const third = time(arrayArm, gen);
  const arr = Math.min(first.median, third.median);
  const map = second.median;

  console.log(
    `${name}  distinct=${distinct}  entries=${WRITES * TOKENS_PER_WRITE}
  array ${arr.toFixed(3)} ms   map ${map.toFixed(3)} ms   ${(arr / map).toFixed(2)}x ${arr > map ? 'FASTER with map' : 'SLOWER with map'}
  array series ${first.series.map((x) => x.toFixed(1)).join(' ')}
  map   series ${second.series.map((x) => x.toFixed(1)).join(' ')}`,
  );
}
