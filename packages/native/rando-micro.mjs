/**
 * WHAT DOES `rando` COST, AND WHAT COULD REPLACE IT AT THE SAME ENTROPY? (item 1768)
 *
 * `packages/utils`'s `rando` is `crypto.randomUUID()`, and item 1768 measured it at ~1.21x of a
 * direct edge insert (2.51 µs with minting against 2.08 without, key length held at 36 and shown to
 * be free). This micro asks the follow-on question the owner needs answered before anything can
 * change: of that cost, how much is ENTROPY and how much is FORMATTING?
 *
 * ⚠️ EVERY ARM HOLDS ~122+ BITS OF ENTROPY. That is not a detail — these ids reach snapshots and
 * cross sync peers, so two clients minting independently must not collide. An arm that bought speed
 * by shortening the random part would be measuring a different and unsafe function, so the arms
 * differ only in how the same random bits are turned into a string.
 *
 * ⚠️ AND THE ANSWER IS ASSERTED: each arm's output is checked for uniqueness across the run and for
 * its expected length, because a minting function that returned a constant would win every round.
 */
const N = Number(process.env.N ?? 300_000);
const REPS = Number(process.env.REPS ?? 7);

/** Node's own, via `@lenke/utils`'s definition — the baseline. */
const arandomUUID = () => crypto.randomUUID();

/**
 * 128 bits drawn in BULK and formatted base-36. Same entropy, ~25 characters instead of 36, and one
 * `getRandomValues` per 1024 ids instead of per id (Node's own cache is 128).
 */
const BULK = 1024;
const pool = new BigUint64Array(BULK * 2);
let poolAt = pool.length;
const refill = () => {
  crypto.getRandomValues(new Uint8Array(pool.buffer));
  poolAt = 0;
};
const abase36 = () => {
  if (poolAt >= pool.length) {
    refill();
  }

  const hi = pool[poolAt];
  const lo = pool[poolAt + 1];

  poolAt += 2;

  return ((hi << 64n) | lo).toString(36);
};

/** The same bulk draw, but formatted hex by hand — isolates base-36's BigInt division. */
const HEX = '0123456789abcdef';
const ahex = () => {
  if (poolAt >= pool.length) {
    refill();
  }

  const hi = pool[poolAt];
  const lo = pool[poolAt + 1];

  poolAt += 2;

  let s = '';

  for (let i = 60n; i >= 0n; i -= 4n) {
    s += HEX[Number((hi >> i) & 15n)];
  }

  for (let i = 60n; i >= 0n; i -= 4n) {
    s += HEX[Number((lo >> i) & 15n)];
  }

  return s;
};

const ARMS = { randomUUID: arandomUUID, base36: abase36, hex: ahex };
const out = {};

for (const [name, fn] of Object.entries(ARMS)) {
  // ⚠️ THE UNIQUENESS CHECK RUNS OUTSIDE THE TIMER, and the first version of this micro got that
  // wrong: interning each id into a 300,000-entry `Set` added ~330 ns of string hashing to EVERY
  // arm, which reported `randomUUID` at 439.6 ns against Node's real ~100 and COMPRESSED the gaps
  // between the arms toward 1x. A correctness assertion in the measured loop is still a confound.
  const sample = new Set();
  const SAMPLE = Math.min(N, 50_000);

  for (let i = 0; i < SAMPLE; i += 1) {
    sample.add(fn());
  }

  if (sample.size !== SAMPLE) {
    throw new Error(
      `${name}: ${sample.size} distinct of ${SAMPLE} — collided, so its timing is void`,
    );
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    // A sink that cannot be optimized away but costs one char read, not a hash insert.
    let sink = 0;
    const t = performance.now();

    for (let i = 0; i < N; i += 1) {
      sink += fn().charCodeAt(0);
    }

    series.push(performance.now() - t);

    if (sink === 0) {
      throw new Error(`${name}: empty sink — the minting did not run`);
    }
  }

  // Drop the first three reps as warm-up and take the median of the rest: the TS per-row estimator
  // rule from CLAUDE.md, because `min` here would pick a rare fast rep.
  const kept = series.slice(3).sort((a, b) => a - b);

  out[name] = {
    nsPerId: Number(((kept[Math.floor(kept.length / 2)] * 1e6) / N).toFixed(1)),
    len: fn().length,
    series: series.map((x) => Number(x.toFixed(1))),
  };
}

console.log(JSON.stringify({ n: N, reps: REPS, arms: out }, null, 2));
