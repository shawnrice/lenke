// Item 1954 — IS `tree()`'s cost the KEY or the TREE? A hand ceiling for the construction itself.
//
// THIS PROBE EXISTS BECAUSE MY FIRST ABLATION LIED, and the failure is worth stating. Replacing
// `treeKey` with a constant took `V().out('E').tree()` from 722.4 ms to 166.8, which reads as "the
// key is 77% of the shape". It is not: a constant key collapses 200,000 distinct top-level entries
// into ONE, so the ablation deleted the TREE as well as the key. Two more arms proved it — a
// `toJSON()`-but-don't-stringify key (few distinct values) measured 377.9 ms while a strictly
// CHEAPER `D1954${id}` key (200,000 distinct, like the real one) measured 638.6, i.e. the arm doing
// LESS work was 260 ms SLOWER because its tree was bigger. Holding key cardinality fixed, the real
// serialization cost is 722.4 - 638.6 = ~84 ms, **11.6% of the shape, not 77%**.
//
// SO THE QUESTION IS THE CONSTRUCTION, and this prices it outside the engine. `treeStep` builds
// levels with `Object.create(null)` and `cursor[key] = next`. At 200,000 distinct long string keys
// the top level goes to dictionary mode, and the comment in `treeStep` records why a nested `Map`
// was rejected — it would `JSON.stringify` to `{}`. That rules out SHIPPING Maps as the tree, not
// building with them and materializing once, so the arms are:
//
//     object   what the engine does: Object.create(null) + cursor[key] = next
//     map      build with Map, then materialize to plain objects in one pass
//
// The shape mirrors the real one: 200,000 top-level keys, five children each.
//
//     bun treeshape-1954.mjs
const TOP = Number(process.env.TOP ?? 200000);
const FAN = Number(process.env.FAN ?? 5);
const REPS = Number(process.env.REPS ?? 7);

/** Long keys like the real ones: `JSON.stringify({id, labels, properties})`. */
const keys = [];

for (let i = 0; i < TOP; i += 1) {
  keys.push(JSON.stringify({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } }));
}

const childKey = (i, c) => keys[(i * 7 + 3 + c * 104_729) % TOP];

const viaObject = () => {
  const root = Object.create(null);

  for (let i = 0; i < TOP; i += 1) {
    const k = keys[i];
    let next = root[k];

    if (!next) {
      next = Object.create(null);
      root[k] = next;
    }

    for (let c = 0; c < FAN; c += 1) {
      const ck = childKey(i, c);

      /*
       * `if (!next[ck])` AND NOT `??=`, DELIBERATELY. This arm has to be what `treeStep` does
       * or it is not a ceiling for it, and `treeStep` writes exactly this truthiness test. The two
       * are equivalent here (values are objects or absent); the point is fidelity, not style.
       */
      // eslint-disable-next-line prefer-nullish-coalescing
      if (!next[ck]) {
        next[ck] = Object.create(null);
      }
    }
  }

  return root;
};

/** Hoisted, not nested in `viaMap`: a per-call closure would be cost the engine does not pay. */
const toPlain = (m) => {
  const out = Object.create(null);

  for (const [k, v] of m) {
    out[k] = toPlain(v);
  }

  return out;
};

const viaMap = () => {
  const root = new Map();

  for (let i = 0; i < TOP; i += 1) {
    const k = keys[i];
    let next = root.get(k);

    if (next === undefined) {
      next = new Map();
      root.set(k, next);
    }

    for (let c = 0; c < FAN; c += 1) {
      const ck = childKey(i, c);

      if (!next.has(ck)) {
        next.set(ck, new Map());
      }
    }
  }

  // MATERIALIZE, because a nested Map stringifies to `{}` — the byte-identity contract.
  return toPlain(root);
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];
  let shape = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn();

    ts.push(performance.now() - t0);

    if (r === 0) {
      // An answer guard: both arms must build the SAME tree, or the comparison is meaningless.
      const top = Object.keys(got).length;
      let kids = 0;

      for (const k of Object.keys(got)) {
        kids += Object.keys(got[k]).length;
      }

      shape = `${String(top)} top / ${String(kids)} children`;
    }
  }

  return { ms: med(ts), shape };
};

const o = time(viaObject);
const m = time(viaMap);

console.log(`TOP=${String(TOP)} FAN=${String(FAN)} REPS=${String(REPS)} median\n`);
console.log(`object  ${o.ms.toFixed(1).padStart(8)} ms   ${o.shape}`);
console.log(`map     ${m.ms.toFixed(1).padStart(8)} ms   ${m.shape}`);
console.log(`\nsame shape? ${String(o.shape === m.shape)}   ratio ${(o.ms / m.ms).toFixed(2)}x`);
