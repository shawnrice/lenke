// Item 2083 — the binding ROUND TRIP in `scanAggregates`: is it worth bypassing?
//
// The loop holds `v`, writes it into a Map, and the accumulator's closure reads it straight back out
// by key. Four arms, ONE PER PROCESS (item 2058: four arms in one process shared a callback site and
// manufactured a sign-consistent 14-23 ns effect that vanished under ARM=).
const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);

const verts = new Array(N);

for (let i = 0; i < N; i++) {
  verts[i] = { id: `v${i}`, properties: { n: i, s: `s${i % 7}` } };
}

const propOf = (el, key) => (el === undefined || el === null ? null : el.properties[key]);
const SV = 'u';

const arms = {
  // What the engine does today: set into the binding, the closure gets it back out.
  roundtrip: () => {
    const binding = new Map();
    const env = { binding };
    const read = (e) => propOf(e.binding.get(SV), 'n');
    let sum = 0;

    for (const v of verts) {
      binding.set(SV, v);
      sum += read(env);
    }

    return sum;
  },
  // The closure is handed the element directly — the Map never involved.
  direct: () => {
    const read = (el) => propOf(el, 'n');
    let sum = 0;

    for (const v of verts) {
      sum += read(v);
    }

    return sum;
  },
  // ⚠️ THE BINDING IS STILL WRITTEN (a gate or a later clause may read it) but the read bypasses it.
  // This is the arm the engine can actually ship if anything else in the loop needs the binding.
  writeonly: () => {
    const binding = new Map();
    const read = (el) => propOf(el, 'n');
    let sum = 0;

    for (const v of verts) {
      binding.set(SV, v);
      sum += read(v);
    }

    return sum;
  },
  // ⚠️ THE CONTROL: the loop and the property read, no closure and no Map. If `direct` is already at
  // this, the closure costs nothing and only the Map is in play.
  floor: () => {
    let sum = 0;

    for (const v of verts) {
      sum += v.properties.n;
    }

    return sum;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

const series = [];
let out;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  out = arms[arm]();
  series.push(performance.now() - t0);
}

// ⚠️ EVERY ARM MUST PRODUCE THE SAME SUM. An arm reading a different thing is not a faster arm.
const expect = (N * (N - 1)) / 2;

if (out !== expect) {
  throw new Error(`${arm} answered ${out}, expected ${expect} — the arms are not equivalent`);
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${arm.padEnd(10)} median=${kept[Math.floor(kept.length / 2)].toFixed(3)} ms  sum=${out}  series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
