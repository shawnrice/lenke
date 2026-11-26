// Item 1963 — would the index-permutation shape help the COLUMN sort arm too?
//
// Item 1962's permuted arm came out FASTER than the column arm it was chasing (37.7 ms against
// ~50 for the same 200,000 rows), which raises the obvious question. But `sortRowsByColumns` is
// central — the plain node arm, the hop arms and the keyed arm all call it — and CLAUDE.md records
// edits to such files costing unrelated rows up to 16% (items 1441/1466, and 1466 declined a 3.3x
// win on that basis). So this prices the shape OUTSIDE the engine first, and the engine is touched
// only if the ceiling justifies it.
//
// THE TWO ARMS, on identical data and producing identical output:
//
//     rows      `rows.sort((a, b) => cmp(a[col], b[col]))`      what the engine does
//     perm      extract the column, sort an index array, permute
//
// THE COMPARATOR IS THE SAME in both arms, so this measures the ACCESS SHAPE and nothing else —
// an object property load per comparison against a typed array-element load. Using a cheaper
// comparator in one arm would measure the comparator instead, which is the confound item 1961 found
// in its own probe.
//
// AND BOTH ARMS MUST BE STABLE. `Array.prototype.sort` is stable, so the index arm keeps arrival
// order on ties exactly as the row arm does — item 605 makes tie order observable, so an arm that
// lost it would be measuring a different (and wrong) operation. The answer guard below compares the
// full ordered sequence of a tag column, not just the keys.
//
//     bun sortshape-1963.mjs
const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
// Ties matter: a fixture of distinct keys cannot see a stability difference, and real sort keys
// repeat (the GQL screen's own fixture gives eight distinct values over 200,000 rows).
const DISTINCT = Number(process.env.DISTINCT ?? 12);

const build = () => {
  const rows = [];

  for (let i = 0; i < N; i += 1) {
    // `t` tags arrival order so tie resolution is readable in the answer.
    rows.push({ x: (i * 2_654_435_761) % DISTINCT, t: i });
  }

  return rows;
};

const cmp = (a, b) => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

/** What the engine does: sort the row objects in place, reading the column per comparison. */
const viaRows = (src) => {
  const rows = src.slice();

  return rows.sort((a, b) => cmp(a.x, b.x));
};

/** Item 1962's shape: one extraction pass, sort an index array, one permutation pass. */
const viaPerm = (src) => {
  const n = src.length;
  const keys = [];
  const idx = [];

  for (let i = 0; i < n; i += 1) {
    keys.push(src[i].x);
    idx.push(i);
  }

  idx.sort((a, b) => cmp(keys[a], keys[b]));

  const out = [];

  for (let j = 0; j < n; j += 1) {
    out.push(src[idx[j]]);
  }

  return out;
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn, src) => {
  const ts = [];
  let sig = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn(src);

    ts.push(performance.now() - t0);

    if (r === 0) {
      // The ORDERED tag sequence: equal keys must come out in arrival order in both arms.
      sig = got.map((row) => row.t).join(',');
    }
  }

  return { ms: med(ts), sig };
};

const src = build();
const a = time(viaRows, src);
const b = time(viaPerm, src);

console.log(`N=${String(N)} DISTINCT=${String(DISTINCT)} REPS=${String(REPS)} median\n`);
console.log(`rows  ${a.ms.toFixed(1).padStart(7)} ms`);
console.log(`perm  ${b.ms.toFixed(1).padStart(7)} ms`);
console.log(
  `\nsame order? ${String(a.sig === b.sig)}   ratio ${(a.ms / b.ms).toFixed(2)}x (>1 means perm wins)`,
);
