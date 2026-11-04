/**
 * THE FLOOR for GQL's undirected hop, and an ablation of where its 2x goes (item 1414).
 *
 * `hopundiryield` (`MATCH (a:P)-[:E]-(b:P) RETURN b.n`) is the most expensive GQL hop row per output
 * row — 365-393 ns/row against the far-driven walk's 147-240 — and it STAYED the outlier after item
 * 1408 took 42% off it. That ratio is stable across out-degree 1, 2 and 4 (2.09x, 1.64x, 1.93x), so
 * it is not a degree artifact and the usual explanation is unavailable: the far-driven walk's cheap
 * property read comes from item 167's hoist, which amortizes over a far vertex's IN-degree, and at
 * `FANIN=1` there is none to amortize.
 *
 * Its windowed profile after 1408 is clean of label frames and reads:
 *
 *   undirectedHopWalk  48.6%     propOf  20.2%     get properties  16.3%     get from  3.8%
 *
 * So 36.5% is the far-vertex property read. ⚠️ BUT A SHARE IS A NOMINATION AND AN ABLATION IS THE
 * PRICE, and this session has twice had a profile name a frame that an ablation priced at nothing —
 * the Gremlin hop's 86.2% generator (real, 2.1x) against the multi-type dedupe's 60.1% (worth
 * −0.5%). Three candidate mechanisms, no evidence between them, so: measure instead of reason.
 *
 * FIVE ARMS, each removing exactly one thing from the one above it:
 *
 *   engine        the real query
 *   twoPass       hand-written: both passes, `{ n: far.properties.n }` per edge     <- the floor
 *   onePass       the out-pass ONLY, so the second pass's cost is engine-independent
 *   noProp        both passes, pushing a CONSTANT — the property read removed
 *   countOnly     both passes, incrementing a counter — row construction removed too
 *
 * `twoPass - onePass` is what the in-pass costs. `twoPass - noProp` is what the property read
 * costs. `noProp - countOnly` is what building the row object costs. `engine - twoPass` is what the
 * engine adds over a hand walk doing the identical work — and if that is near zero, this row is at
 * its floor and the 36.5% is irreducible at this access order, which is the answer rather than a
 * target.
 *
 *   NODES=100000 REPS=14 MULTILABEL=-1 node gql-undirected-floor-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 100_000);
const FANOUT = Number(process.env.FANOUT ?? 1);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
/** `-1` is disjoint: every other edge carries `F` INSTEAD of `E`, matching the bench's own knob. */
const MULTILABEL = Number(process.env.MULTILABEL ?? -1);

const edgeLabels = (k) => {
  if (MULTILABEL === -1) {
    return k % 2 === 0 ? ['E'] : ['F'];
  }

  return MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'];
};

/** Byte-identical to `isolated-row-bench.mjs`'s fixture at `FANIN=1`. */
const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: { k: i % 97, s: `s${i % 1000}`, n: i },
      }),
    );
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % NODES],
      to: vs[(k * 104_729) % NODES],
      labels: edgeLabels(k),
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();
const SRC = 'MATCH (a:P)-[:E]-(b:P) RETURN b.n AS n';

const engine = () => query(g, SRC);

/**
 * THE FLOOR. Both passes, in the same order the walk uses, skipping a self-loop in the in-pass
 * because the out-pass already emitted it — the one semantic detail that cannot be dropped without
 * changing the row count.
 */
const twoPass = () => {
  const rows = [];

  for (const v of g.vertices) {
    const out = v.adjFrom?.get('E');

    if (out !== undefined) {
      for (const e of out) {
        rows.push({ n: e.to.properties['n'] });
      }
    }

    const inc = v.adjTo?.get('E');

    if (inc !== undefined) {
      for (const e of inc) {
        if (e.from !== e.to) {
          rows.push({ n: e.from.properties['n'] });
        }
      }
    }
  }

  return rows;
};

/** The out-pass only — so the in-pass's share is measured, not assumed to be half. */
const onePass = () => {
  const rows = [];

  for (const v of g.vertices) {
    const out = v.adjFrom?.get('E');

    if (out !== undefined) {
      for (const e of out) {
        rows.push({ n: e.to.properties['n'] });
      }
    }
  }

  return rows;
};

/** Both passes, a CONSTANT in the row: the far-vertex property read removed, nothing else. */
const noProp = () => {
  const rows = [];

  for (const v of g.vertices) {
    const out = v.adjFrom?.get('E');

    if (out !== undefined) {
      for (const _e of out) {
        rows.push({ n: 0 });
      }
    }

    const inc = v.adjTo?.get('E');

    if (inc !== undefined) {
      for (const e of inc) {
        if (e.from !== e.to) {
          rows.push({ n: 0 });
        }
      }
    }
  }

  return rows;
};

/** Both passes, no row objects at all: the adjacency walk alone. */
const countOnly = () => {
  let n = 0;

  for (const v of g.vertices) {
    const out = v.adjFrom?.get('E');

    if (out !== undefined) {
      for (const _e of out) {
        n += 1;
      }
    }

    const inc = v.adjTo?.get('E');

    if (inc !== undefined) {
      for (const e of inc) {
        if (e.from !== e.to) {
          n += 1;
        }
      }
    }
  }

  return { length: n };
};

const ARMS = { engine, twoPass, onePass, noProp, countOnly };

const time = (fn) => {
  const series = [];
  let len = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = fn();

    series.push(performance.now() - t0);
    len = rows.length;
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { p25: kept[Math.floor(kept.length * 0.25)], len };
};

const names = Object.keys(ARMS);
const got = {};

// ALTERNATE the arm order across rounds, so a warming JIT cannot favour whichever ran first.
for (let round = 0; round < 3; round += 1) {
  for (const n of round % 2 === 0 ? names : [...names].reverse()) {
    (got[n] ??= []).push(time(ARMS[n]));
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

// ⚠️ THE ARMS THAT CLAIM THE SAME ROW SET MUST AGREE ON IT. `onePass` deliberately does not, so it
// is checked against its own expectation instead: strictly fewer rows, and more than none.
const full = ['engine', 'twoPass', 'noProp', 'countOnly'].map((n) => got[n][0].len);

if (new Set(full).size !== 1) {
  throw new Error(`full-row arms disagree: ${full.join(' vs ')}`);
}

const [rows] = full;

if (!(got['onePass'][0].len > 0 && got['onePass'][0].len < rows)) {
  throw new Error(`onePass should be a strict subset: ${got['onePass'][0].len} of ${rows}`);
}

const V = Object.fromEntries(names.map((n) => [n, med(got[n].map((r) => r.p25))]));

console.log(
  JSON.stringify({
    nodes: NODES,
    fanout: FANOUT,
    multilabel: MULTILABEL,
    rows,
    onePassRows: got['onePass'][0].len,
    arms: Object.fromEntries(names.map((n) => [n, Number(V[n].toFixed(2))])),
  }),
);

console.log(`\n  ${rows} rows (out-pass alone: ${got['onePass'][0].len})\n`);

for (const n of names) {
  console.log(
    `  ${n.padEnd(10)} ${V[n].toFixed(2).padStart(8)} ms   ` +
      `${((V[n] * 1e6) / rows).toFixed(0).padStart(4)} ns/row   ` +
      `${(V[n] / V['twoPass']).toFixed(2)}x floor`,
  );
}

console.log('\n  ablations:');
console.log(`    engine over the floor      ${(V['engine'] / V['twoPass']).toFixed(2)}x`);
console.log(
  `    the in-pass costs          ${(V['twoPass'] - V['onePass']).toFixed(2)} ms ` +
    `(${(100 * (V['twoPass'] - V['onePass'])) / V['twoPass']}% of the floor)`,
);
console.log(
  `    the property read costs    ${(V['twoPass'] - V['noProp']).toFixed(2)} ms ` +
    `(${((100 * (V['twoPass'] - V['noProp'])) / V['twoPass']).toFixed(1)}% of the floor)`,
);
console.log(
  `    building the row costs     ${(V['noProp'] - V['countOnly']).toFixed(2)} ms ` +
    `(${((100 * (V['noProp'] - V['countOnly'])) / V['twoPass']).toFixed(1)}% of the floor)`,
);
console.log(
  `    the adjacency walk alone   ${V['countOnly'].toFixed(2)} ms ` +
    `(${((100 * V['countOnly']) / V['twoPass']).toFixed(1)}% of the floor)`,
);
