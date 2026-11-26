// Item 2083 — `sum` MATERIALIZES then makes three passes. Item 2077 priced the PASSES. This prices
// the PUSH, which is the term it did not separate.
const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);
const isTemporal = (v) => typeof v === 'object' && v !== null && 'kind' in v;
const numArg = (v) => (typeof v === 'number' ? v : Number(v));

const verts = new Array(N);

for (let i = 0; i < N; i++) {
  verts[i] = { properties: { n: i } };
}

const arms = {
  // What the engine does: push every value, then some()/some()/reduce().
  pushthenpass: () => {
    const values = [];

    for (const v of verts) {
      const value = v.properties.n;

      if (value === null || value === undefined) {
        continue;
      }

      values.push(value);
    }

    if (values.some(isTemporal)) {
      throw new Error('nope');
    }

    if (values.some(Array.isArray)) {
      throw new Error('nope');
    }

    return values.reduce((s, x) => s + numArg(x), 0);
  },
  // THE PUSH ALONE — the array is built and then only its LENGTH read, so the three passes are
  // excluded. This is the term item 2077 did not separate.
  pushonly: () => {
    const values = [];

    for (const v of verts) {
      const value = v.properties.n;

      if (value === null || value === undefined) {
        continue;
      }

      values.push(value);
    }

    return values.length === N ? values.reduce((s, x) => s + x, 0) : -1;
  },
  // A streaming fold: no array at all. The answer a fold could produce IF the semantics allowed it.
  streamfold: () => {
    let sum = 0;

    for (const v of verts) {
      const value = v.properties.n;

      if (value === null || value === undefined) {
        continue;
      }

      sum += numArg(value);
    }

    return sum;
  },
  // THE CONTROL: the walk and the read, no accumulation beyond a bare add.
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

const expect = (N * (N - 1)) / 2;

if (out !== expect) {
  throw new Error(`${arm} answered ${out}, expected ${expect} — arms not equivalent`);
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${arm.padEnd(13)} median=${kept[Math.floor(kept.length / 2)].toFixed(3)} ms  series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
