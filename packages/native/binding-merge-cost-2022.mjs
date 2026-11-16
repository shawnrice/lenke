/**
 * Item 2022 — WHAT DOES `new Map([...b, ...t])` COST PER PRODUCT ROW, AND WHAT IS CHEAPER?
 *
 * ⚠️⚠️ **THE NOMINATION.** `visitRemaining`'s uncorrelated-tail product (item 121) is **43.5% self
 * with another 21.3% in the garbage collector** on the GQL surface's largest shape — the comma
 * pattern `MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T)`, 2098 ms for 6,750,000 rows unordered. The
 * tail is already matched once and cached; what is left is one line, run per output row:
 *
 * ```js
 *     yield new Map([...b, ...t]);
 * ```
 *
 * Two array spreads — each materializing a two-element array per entry — a concat, and a fresh `Map`
 * insert per entry. Same shape as the per-row merge item 2017 removed from `applyProjection`.
 *
 * 🔑 **THIS FILE PRICES THE MECHANISM BEFORE ANY ENGINE EDIT**, because the alternatives differ in
 * how much they constrain the consumer:
 *
 * ```text
 *     spread    new Map([...b, ...t])          — what the engine does
 *     copyset   new Map(b) then t.set loop     — same result, no intermediate arrays
 *     presized  new Map(b) with t pre-merged   — the floor for "a Map per row"
 *     facade    a ReadonlyMap-shaped VIEW      — no copy at all; constrains every consumer
 * ```
 *
 * ⚠️ THE FIXTURE MIRRORS THE ENGINE'S SHAPE, not a generic Map benchmark: `b` carries the outer
 * binding plus its own pattern's variables, `t` carries the outer binding plus the tail's, and the
 * two OVERLAP on the outer keys (the engine's own comment says so). Key COUNT and overlap both change
 * the answer, so they are the engine's.
 *
 * ⚠️ AND KEY ORDER IS LOAD-BEARING, which is why `facade` is priced but not assumed: `visitRemaining`
 * documents the merge order as "outer keys, then `pat`'s, then the tail's — which `RETURN *` projects
 * in", and [[column-order-is-observable]] makes that bytes. Every arm below is checked to produce the
 * SAME key order as `spread`, and an arm that does not is reported rather than timed.
 *
 *     ARM=spread bun binding-merge-cost-2022.mjs
 *     ROWS=6750000 ARM=copyset bun binding-merge-cost-2022.mjs
 */
const ROWS = Number(process.env.ROWS ?? 2_250_000);
const REPS = Number(process.env.REPS ?? 7);
const ARM = process.env.ARM ?? 'spread';

/*
 * The engine's shape: an outer binding of one variable, `b` adding two more, `t` adding two more.
 * `a` is the overlap — present in both, same value, and the tail's copy wins in the spread form.
 */
const outer = [['a', { id: 'a0' }]];
const B = new Map([...outer, ['b', { id: 'b0' }], ['e', { id: 'e0' }]]);
const TAILS = [];

for (let i = 0; i < 64; i += 1) {
  TAILS.push(new Map([...outer, ['c', { id: `c${i}` }], ['d', { id: `d${i}` }]]));
}

const spread = (b, t) => new Map([...b, ...t]);

const copyset = (b, t) => {
  const m = new Map(b);

  for (const [k, v] of t) {
    m.set(k, v);
  }

  return m;
};

/*
 * ⚠️ `presized` IS NOT A PROPOSAL — it cheats by knowing the key set, which the engine does not at
 * this point. It is here as the FLOOR for "allocate one Map per row", so `copyset` is not read as
 * the ceiling (the same role item 2017's columnar arm played, and item 1893's `Float64Array` one).
 */
const KEYS = [...spread(B, TAILS[0]).keys()];
const presized = (b, t) => {
  const m = new Map();

  for (const k of KEYS) {
    m.set(k, t.has(k) ? t.get(k) : b.get(k));
  }

  return m;
};

/**
 * A VIEW over the two maps, no copy. ⚠️ It must satisf`ReadonlyMap`: consumers call `get`, `has`,
 * `size` and ITERATE (`RETURN *` copies entries, `rowKey` builds a dedup key from them), so a
 * partial facade would be a wrong answer rather than a faster one.
 */
class MergedBinding {
  #b;
  #t;

  constructor(b, t) {
    this.#b = b;
    this.#t = t;
  }

  get(k) {
    return this.#t.has(k) ? this.#t.get(k) : this.#b.get(k);
  }

  has(k) {
    // ⚠️ TWO RETURNS, NOT `||`: in an untyped `.mjs` the lint cannot see these are booleans and
    // suggests `??`, which would be WRONG here (`false ?? x` is `false`).
    if (this.#t.has(k)) {
      return true;
    }

    return this.#b.has(k);
  }

  get size() {
    let n = this.#b.size;

    for (const k of this.#t.keys()) {
      if (!this.#b.has(k)) {
        n += 1;
      }
    }

    return n;
  }

  *[Symbol.iterator]() {
    // ⚠️ THE SPREAD'S ORDER: `b`'s keys first (with the TAIL's value where both have one, because a
    // later `set` wins in `new Map([...b, ...t])`), then the tail's keys `b` does not have.
    for (const [k, v] of this.#b) {
      yield [k, this.#t.has(k) ? this.#t.get(k) : v];
    }

    for (const [k, v] of this.#t) {
      if (!this.#b.has(k)) {
        yield [k, v];
      }
    }
  }

  *keys() {
    for (const [k] of this) {
      yield k;
    }
  }

  *values() {
    for (const [, v] of this) {
      yield v;
    }
  }

  entries() {
    return this[Symbol.iterator]();
  }

  forEach(fn) {
    for (const [k, v] of this) {
      fn(v, k, this);
    }
  }
}

const facade = (b, t) => new MergedBinding(b, t);

/*
 * ⚠️ ITEM 2024's ARM: REUSE ONE MAP ACROSS THE INNER LOOP. In `visitRemaining`'s cached-tail product
 * the OUTER binding is fixed for the whole inner loop and only the TAIL's keys vary — and the tail's
 * key SET is fixed too. So the merged map can be built once per outer row and have only the tail's
 * keys overwritten per inner row: no allocation at all in the inner loop.
 *
 * ⚠️⚠️ **IT IS ONLY SOUND IF NO CONSUMER RETAINS THE YIELDED BINDING PAST THE NEXT ITERATION**, which
 * is the whole question and is NOT answered by this probe. The pattern is already established in this
 * engine — `projectRow`'s note records that every caller in `hop-projection.ts` "passes a `Binding`
 * allocated once and mutated in place" — so the shape is not novel; whether the matcher's consumers
 * allow it is a separate audit.
 *
 * ⚠️ AND THE PROBE MUST NOT FLATTER IT THE WAY THE `facade` ARM WAS FLATTERED (item 2023): the row is
 * READ inside the loop, so a reused map that the consumer would have had to copy is not counted as
 * free. What this arm cannot show is a consumer that RETAINS, which is exactly what killed the view.
 */
const reuse = (() => {
  let merged;
  let lastOuter;

  return (b, t) => {
    if (lastOuter !== b) {
      merged = new Map(b);
      lastOuter = b;
    }

    for (const [k, v] of t) {
      merged.set(k, v);
    }

    return merged;
  };
})();

const ARMS = { spread, copyset, presized, facade, reuse };
const build = ARMS[ARM];

if (build === undefined) {
  console.log(`unknown ARM=${ARM}; one of ${Object.keys(ARMS).join(' ')}`);
  process.exit(1);
}

/*
 * ⚠️ EVERY ARM IS CHECKED AGAINST `spread` FOR KEY ORDER *AND* VALUES BEFORE IT IS TIMED. An arm that
 * merges in the other order is faster and wrong, and a column-order change is bytes
 * ([[column-order-is-observable]]).
 */
const render = (m) => JSON.stringify([...m].map(([k, v]) => `${k}=${v.id}`));
const want = render(spread(B, TAILS[3]));
const got = render(build(B, TAILS[3]));

if (want !== got) {
  console.log(
    `# ⚠️ ARM=${ARM} DISAGREES WITH \`spread\` — not timed\n#   want ${want}\n#   got  ${got}`,
  );
  process.exit(1);
}

const series = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < ROWS; i += 1) {
    const m = build(B, TAILS[i & 63]);

    // ⚠️ THE RESULT MUST BE READ, or an arm that builds nothing is optimized away and measures as
    // free. A `get` is what the consumer does with it.
    if (m.get('d') !== undefined) {
      sink += 1;
    }
  }

  series.push(performance.now() - t0);
}

const sorted = [...series].sort((a, b) => a - b);
const [best] = sorted;

console.log(`# ROWS=${String(ROWS)} ARM=${ARM} sink=${String(sink)} ${want}`);
console.log(`series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
console.log(`best ${best.toFixed(1)} ms   ${((best * 1e6) / ROWS).toFixed(0)} ns/row`);
