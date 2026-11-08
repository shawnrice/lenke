/**
 * WHAT DOES THE ITERATOR PROTOCOL COST A 3-HOP VALUES WALK, AND WHAT IS THE CEILING IF IT GOES?
 *
 * `V().hasLabel(P).out(E)x3.values(age)` is the largest absolute cost in the gremlin corpus — 6813 ms
 * TS against 1134 native, 6.0x, where the next row is 1140. Profiled at 200,000 vertices / 1,000,000
 * edges over 25,000,000 output rows, 8830 ms/call:
 *
 *     44.0%  walk              the DFS, `its[d].next()` per edge
 *     27.4%  pick              the per-row value extraction
 *     16.5%  get properties
 *
 * `walk` drives the chain with explicit `Set` iterators, so every edge visited allocates a fresh
 * `{value, done}` result object — 25,000,000 of them at the last level alone. Items 1411/1412 already
 * priced the generator protocol at 1.9-2.2x and `drain` at 53.8% of `V().out(E)`, so this is a known
 * shape rather than a guess.
 *
 * ⚠️ THIS PROBE PRICES THE LEVER BEFORE THE ROUTE IS BUILT, which is the whole point: item 1678's
 * chain CSR already exists and would replace those `.next()` calls with `Int32Array` indexing, but a
 * new values route is a large change to a hot file where `executor-edits-perturb` is measured, and
 * `check-the-blocker-still-holds` cuts both ways. Three arms over the SAME adjacency:
 *
 *   setProtocol   the current shape: nested `Set` iterators via `[Symbol.iterator]()`/`.next()`
 *   setForOf      the same Sets walked with `for..of`, which V8 can often fuse
 *   csrIndexed    flat `Int32Array` runs, indexed — what item 1678's CSR makes available
 *
 * All three visit the same edges in the same order and compute the same checksum, which is asserted,
 * so an arm that skips work cannot read fast.
 *
 *   node gremlin-walk-protocol-probe.mjs
 *   N=200000 FANOUT=5 node gremlin-walk-protocol-probe.mjs
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 100_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const DEPTH = Number(process.env.DEPTH ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } }));
}

let e = 0;

for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[(i * 7919 + r * 104_729 + 13) % N],
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

/** The flat CSR, built once and EXCLUDED from the timed region — item 1678 caches it. */
const order = [...g.verticesById.values()];
const idx = new Map();

for (let i = 0; i < order.length; i += 1) {
  idx.set(order[i], i);
}

const off = new Int32Array(order.length + 1);
const nbr = new Int32Array(g.edgeCount);
// The per-slot `age`, so the CSR arm reads a value without touching an element at all.
const age = new Float64Array(order.length);
let at = 0;

for (let i = 0; i < order.length; i += 1) {
  off[i] = at;
  age[i] = Number(order[i].properties.age);

  for (const edge of order[i].adjFrom?.get('E') ?? []) {
    nbr[at] = idx.get(edge.to) ?? 0;
    at += 1;
  }
}

off[order.length] = at;

/** The CURRENT shape: explicit iterators and `.next()`, one result object per edge visited. */
const setProtocol = () => {
  let sum = 0;
  const its = Array.from({ length: DEPTH });

  for (const v of order) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = b0[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d].next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const far = step.value.to;

      if (d === DEPTH - 1) {
        sum += Number(far.properties.age);
        continue;
      }

      const next = far.adjFrom?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = next[Symbol.iterator]();
    }
  }

  return sum;
};

/** The same Sets, walked with `for..of` at a fixed depth — no explicit iterator objects in user code. */
const setForOf = () => {
  let sum = 0;

  for (const v of order) {
    for (const e1 of v.adjFrom?.get('E') ?? []) {
      for (const e2 of e1.to.adjFrom?.get('E') ?? []) {
        for (const e3 of e2.to.adjFrom?.get('E') ?? []) {
          sum += Number(e3.to.properties.age);
        }
      }
    }
  }

  return sum;
};

/** Flat runs, indexed — no iterator, no element dereference, no property getter. */
const csrIndexed = () => {
  let sum = 0;

  for (let s = 0; s < order.length; s += 1) {
    for (let i = off[s]; i < off[s + 1]; i += 1) {
      const a = nbr[i];

      for (let j = off[a]; j < off[a + 1]; j += 1) {
        const b = nbr[j];

        for (let k = off[b]; k < off[b + 1]; k += 1) {
          sum += age[nbr[k]];
        }
      }
    }
  }

  return sum;
};

/**
 * ⚠️ THE SINK IS THE REAL BOUND, AND WITHOUT THIS ARM THE CEILING IS A FANTASY. `csrIndexed` sums
 * into a scalar, but `values(k)` must MATERIALIZE every row — the bench row's 6813 ms includes
 * building a 25,000,000-element array. So the achievable win is bounded by what it costs to push
 * that many values however fast the walk gets, and these two arms bracket it.
 */
const csrToArray = () => {
  const out = [];

  for (let s = 0; s < order.length; s += 1) {
    for (let i = off[s]; i < off[s + 1]; i += 1) {
      const a = nbr[i];

      for (let j = off[a]; j < off[a + 1]; j += 1) {
        const b = nbr[j];

        for (let k = off[b]; k < off[b + 1]; k += 1) {
          out.push(age[nbr[k]]);
        }
      }
    }
  }

  return out.length;
};

/** The current shape, also materializing — so the pair is a like-for-like comparison. */
const setProtocolToArray = () => {
  const out = [];
  const its = Array.from({ length: DEPTH });

  for (const v of order) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = b0[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d].next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const far = step.value.to;

      if (d === DEPTH - 1) {
        out.push(far.properties.age);
        continue;
      }

      const next = far.adjFrom?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = next[Symbol.iterator]();
    }
  }

  return out.length;
};

const ARMS = { setProtocol, setForOf, csrIndexed, setProtocolToArray, csrToArray };

const ROWCOUNT = new Set(['setProtocolToArray', 'csrToArray']);

// ⚠️ EVERY ARM MUST AGREE, or a fast reading is just an arm doing less work.
const expected = setProtocol();
const expectedRows = setProtocolToArray();

for (const [name, fn] of Object.entries(ARMS)) {
  const got = fn();
  const want = ROWCOUNT.has(name) ? expectedRows : expected;

  if (got !== want) {
    throw new Error(`ARM ${name} COMPUTED ${got}, EXPECTED ${want} — not measuring the same walk`);
  }
}

const timed = (fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return { median: warm[Math.floor(warm.length / 2)], series };
};

const names = Object.keys(ARMS);
const best = {};
const seriesOf = {};

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    const { median, series } = timed(ARMS[nm]);

    if (median < (best[nm] ?? Infinity)) {
      best[nm] = median;
      seriesOf[nm] = series;
    }
  }
}

console.log(
  `\nWALK PROTOCOL — ${N} vertices / ${g.edgeCount} edges, depth ${DEPTH}, ` +
    `checksum ${expected}, ${expectedRows} rows\n`,
);
console.log('arm                      ms    vs setProtocol');

for (const nm of names) {
  const base = ROWCOUNT.has(nm) ? best.setProtocolToArray : best.setProtocol;

  console.log(
    `${nm.padEnd(21)} ${best[nm].toFixed(1).padStart(7)}  ${(base / best[nm]).toFixed(2).padStart(10)}x`,
  );
}

console.log('\nper-rep series:');

for (const nm of names) {
  console.log(`  ${nm.padEnd(21)} ${seriesOf[nm].map((x) => x.toFixed(0)).join(' ')}`);
}

console.log(
  '\ncsrIndexed is the CEILING, not a proposal: it reads a per-slot `age` array, where the real\n' +
    'route must return whatever `values(k)` names and honour per-hop gates. setForOf is the cheap\n' +
    'half of the lever — same data structures, no explicit iterator objects.',
);
