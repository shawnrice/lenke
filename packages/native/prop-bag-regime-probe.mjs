/**
 * WHY does the property-read path grow 2.5-4x from 20k to 200k elements (item 1362)?
 *
 * Item 1362 named a mechanism — `element.properties[key]` on a frozen plain object with arbitrary
 * keys is V8 dictionary mode, megamorphic across 200,000 distinct bags — and explicitly did NOT
 * measure it. **That explanation is suspect on its own terms** and this probe exists to find out:
 * the engine fixture gives every vertex the SAME three keys (`k`, `s`, `n`), so all 200,000 bags
 * share one hidden class and the read site should be MONOMORPHIC. If that is right, the growth is
 * memory locality, not shape polymorphism, and the "dictionary mode" story is wrong.
 *
 * Four questions, each isolated, each swept over element count so the regime shows:
 *
 *   locality     same keys on every bag (one hidden class). Pure cache behaviour as the heap grows.
 *   shapes       a different key SET per bag group, so the read site goes polymorphic then
 *                megamorphic. The difference against `locality` at the same N IS the shape cost.
 *   frozen       same as `locality` but `Object.freeze`d, which is what the engine actually stores.
 *   mapbag       the candidate FIX: a `Map` per element instead of a plain object.
 *
 * Read `locality` against `shapes` to attribute the growth, and `frozen`/`mapbag` against
 * `locality` to price the two levers. A ratio that is FLAT in N is not the explanation for something
 * that grows in N — that is the whole test.
 *
 *     node prop-bag-regime-probe.mjs            # sweeps 1k / 20k / 200k
 *
 * ⚠️ Reads are shuffled by a deterministic LCG so the access pattern is not sequential. Walking bags
 * in allocation order measures the prefetcher, not the engine's access pattern, and would make every
 * arm look flat.
 */
const SIZES = [1000, 20_000, 200_000];
const READS = 2_000_000;
const REPS = 9;
const DROP = 2;

/** Dep-free deterministic LCG, in integer math. f64 overflows past 2^53 and the period collapses. */
const lcg = (seed) => {
  let s = seed >>> 0;

  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;

    return s;
  };
};

const buildLocality = (n) =>
  Array.from({ length: n }, (_, i) => ({ k: i % 97, s: `s${i % 1000}`, n: i }));

const buildFrozen = (n) => buildLocality(n).map((b) => Object.freeze(b));

/**
 * EIGHT distinct key sets, which is past V8's polymorphic limit (4) and so megamorphic at the read
 * site, while every bag still answers `k`.
 */
const buildShapes = (n) =>
  Array.from({ length: n }, (_, i) => {
    const extra = i % 8;
    const bag = { k: i % 97 };

    for (let j = 0; j <= extra; j += 1) {
      bag[`x${j}`] = j;
    }

    bag.s = `s${i % 1000}`;
    bag.n = i;

    return bag;
  });

const buildMapBag = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      new Map([
        ['k', i % 97],
        ['s', `s${i % 1000}`],
        ['n', i],
      ]),
  );

/** Object-bag read: what `propOf` does. */
const readObj = (bags, idx) => {
  let acc = 0;

  for (let r = 0; r < READS; r += 1) {
    const bag = bags[idx[r]];
    const v = bag.k;

    acc += typeof v === 'number' ? v : 0;
  }

  return acc;
};

/** Map-bag read: the candidate fix. */
const readMap = (bags, idx) => {
  let acc = 0;

  for (let r = 0; r < READS; r += 1) {
    const v = bags[idx[r]].get('k');

    acc += typeof v === 'number' ? v : 0;
  }

  return acc;
};

/**
 * THE COUNTERFACTUAL: one `Float64Array` of the `k` column, indexed by element ordinal.
 *
 * This is not a proposal — it is the FLOOR that a columnar layout would pay, so the gap between it
 * and `locality` prices the layout lever instead of leaving it as an adjective. It is what the
 * native engine does (its vertices ARE dense `u32` ids and its columns ARE typed arrays), and it is
 * why the TS/native property-read ratio is a layout difference rather than an overhead difference.
 */
const buildColumnar = (n) => {
  const col = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    col[i] = i % 97;
  }

  return col;
};

const readColumn = (col, idx) => {
  let acc = 0;

  for (let r = 0; r < READS; r += 1) {
    acc += col[idx[r]];
  }

  return acc;
};

const ARMS = {
  locality: { build: buildLocality, read: readObj },
  shapes: { build: buildShapes, read: readObj },
  frozen: { build: buildFrozen, read: readObj },
  mapbag: { build: buildMapBag, read: readMap },
  columnar: { build: buildColumnar, read: readColumn },
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

const time = (read, bags, idx) => {
  const series = [];
  let out = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = read(bags, idx);
    series.push(performance.now() - t0);
  }

  if (out === 0) {
    throw new Error('read produced 0 — measuring nothing');
  }

  return median(series.slice(DROP));
};

console.log(`READS=${READS}  REPS=${REPS} drop ${DROP}  key='k'`);
console.log(
  `\n${'size'.padStart(8)}${'locality'.padStart(11)}${'shapes'.padStart(11)}${'frozen'.padStart(11)}${'mapbag'.padStart(11)}${'columnar'.padStart(11)}   ns/read (locality)`,
);

const firstRow = {};

for (const n of SIZES) {
  // One shuffled index per size, SHARED by every arm, so the arms differ only in the bag layout.
  const rnd = lcg(0x9e37_79b9 ^ n);
  const idx = new Int32Array(READS);

  for (let r = 0; r < READS; r += 1) {
    idx[r] = rnd() % n;
  }

  const got = {};

  for (const [name, arm] of Object.entries(ARMS)) {
    got[name] = time(arm.read, arm.build(n), idx);
  }

  if (firstRow.locality === undefined) {
    Object.assign(firstRow, got);
  }

  const cells = ['locality', 'shapes', 'frozen', 'mapbag', 'columnar']
    .map((k) => got[k].toFixed(1).padStart(11))
    .join('');

  console.log(`${String(n).padStart(8)}${cells}   ${((got.locality * 1e6) / READS).toFixed(2)} ns`);
}

console.log(`
Read it this way:
  * locality growing with size   -> the cost is CACHE, and item 1362's dictionary-mode story is wrong
  * shapes/locality > 1 and GROWING with size -> shape polymorphism is a real part of it
  * frozen/locality far from 1   -> Object.freeze itself is on the read path
  * mapbag/locality < 1 at 200k  -> a Map bag is the lever, and by how much`);

const ratios = (label, a, b) => `  ${label.padEnd(18)} ${(a / b).toFixed(2)}x`;

console.log(`\nAt the SMALLEST size (${SIZES[0]}):`);
console.log(ratios('shapes/locality', firstRow.shapes, firstRow.locality));
console.log(ratios('frozen/locality', firstRow.frozen, firstRow.locality));
console.log(ratios('mapbag/locality', firstRow.mapbag, firstRow.locality));
