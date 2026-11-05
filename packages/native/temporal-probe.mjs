/**
 * TEMPORAL VALUES HAD NO BENCH ROW AT ALL — `packages/core/src/temporal.ts` is 1,333 lines, reached
 * from BOTH engines' comparison paths (`gql/src/executor/scalars.ts`, `gremlin/src/executor/
 * dispatch.ts`), and item 1467's triage found zero mentions of it anywhere in the probe corpus.
 *
 * It matters disproportionately here: this repo's own notes record the domain as a people-graph over
 * TIME (an ATS / HRIS model), so dates are not an exotic column — they are the modelling primitive,
 * and a bitemporal fact table filters and orders on them constantly.
 *
 * ⚠️ EVERY PAIR COMPARES LIKE WITH LIKE, with the same row count at each stage, because a temporal
 * predicate that selects a different fraction than its numeric twin would make the ratio meaningless.
 * The vertex carries BOTH a `num` and a `d` encoding the same ordinal, so `num > X` and
 * `d > DATE '…'` select the identical set, and the probe asserts the row counts match before
 * printing a ratio.
 *
 * ⚠️ THE TAIL IS A MATERIALIZING ONE. Four tails in this corpus answer without doing the work (chain
 * count 1479, values walk 1480/1483, presence count 1485, hop-count 1488), and a bare `count()` here
 * would risk a fifth. `RETURN … ORDER BY … LIMIT` forces the comparison work out.
 *
 *     NODES=200000 REPS=9 node temporal-probe.mjs
 *     PAIR=order node temporal-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gt, has, hasLabel, order, toArray, traversal, values } from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const ONLY = process.env.PAIR;

/** Day `i` of 2020 onwards, as the tagged JSON form the engine stores. */
const dayOf = (i) => {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000);

  return { '@date': d.toISOString().slice(0, 10) };
};

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    // `num` and `d` encode the SAME ordinal, so a numeric and a temporal predicate over them
    // select the identical subset. 4000 distinct days, cycled, so ORDER BY has real ties.
    const ord = i % 4000;

    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { num: ord, d: dayOf(ord), k: i % 97 },
    });
  }

  return g;
};

// `ord > 3600` keeps 10% of 4000 days; DATE '2029-11-16' is day 3607 from 2020-01-01.
const CUT_DAY = new Date(Date.UTC(2020, 0, 1) + 3600 * 86_400_000).toISOString().slice(0, 10);

const PAIRS = {
  filter: {
    note: 'a > predicate over 200,000 rows, 10% selective',
    numeric: 'MATCH (n:P) WHERE n.num > 3600 RETURN count(*) AS c',
    temporal: `MATCH (n:P) WHERE n.d > DATE '${CUT_DAY}' RETURN count(*) AS c`,
  },
  order: {
    note: 'ORDER BY + LIMIT over the selected tenth — the comparison path',
    numeric: 'MATCH (n:P) WHERE n.num > 3600 RETURN n.num AS v ORDER BY v LIMIT 10',
    temporal: `MATCH (n:P) WHERE n.d > DATE '${CUT_DAY}' RETURN n.d AS v ORDER BY v LIMIT 10`,
  },
  project: {
    note: 'a bare read of every row, no comparison at all — isolates VALUE cost from compare cost',
    numeric: 'MATCH (n:P) RETURN n.num AS v',
    temporal: 'MATCH (n:P) RETURN n.d AS v',
  },
  grouped: {
    note: 'GROUP BY the value — hashing/keying a temporal against a number',
    numeric: 'MATCH (n:P) RETURN n.num AS v, count(*) AS c',
    temporal: 'MATCH (n:P) RETURN n.d AS v, count(*) AS c',
  },
};

// ⚠️ `ARM` exists so a PROFILE covers ONE arm. Profiling both in one window attributes the temporal
// frames and the numeric frames to the same capture, which is how a 2.74x gap becomes unreadable.
const { ARM } = process.env;

if (ARM !== undefined && ARM !== 'numeric' && ARM !== 'temporal') {
  throw new Error(`ARM must be numeric|temporal, got ${ARM}`);
}

const names = ONLY === undefined ? Object.keys(PAIRS) : [ONLY];

for (const n of names) {
  if (PAIRS[n] === undefined) {
    throw new Error(`unknown PAIR ${n}; have ${Object.keys(PAIRS).join(',')}`);
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const graph = build();

console.log(`\nTEMPORAL vs NUMERIC — NODES=${NODES} REPS=${REPS} DROP=${DROP}\n`);
console.log(
  `${'pair'.padEnd(10)}${'numeric'.padStart(10)}${'temporal'.padStart(11)}${'ratio'.padStart(9)}  rows`,
);

for (const name of names) {
  const pair = PAIRS[name];
  // ⚠️ The fixture is built BEFORE any window opens, so a `PROF_OUT` capture never contains the
  // load — PROBES.md's rule, and item 1464 diluted a profile by ignoring it.
  const timed = (text) =>
    profileWindow(process.env.PROF_OUT, () => {
      const reps = [];
      let rows = 0;
      let witness = null;

      for (let r = 0; r < REPS; r += 1) {
        const t0 = performance.now();
        const out = query(graph, text);

        reps.push(performance.now() - t0);
        rows = out.length;
        // ⚠️ THE ROW COUNT IS NOT THE ANSWER, and comparing it was a WEAK GUARD: `count(*)` returns
        // one row and `LIMIT 10` returns ten whatever the predicate selected, so two pairs with
        // different selectivity would have passed. The witness is the first row's FIRST COLUMN — the
        // tally for a count pair, the smallest selected value for an ordered pair — which does move
        // with the selected set.
        witness = out.length === 0 ? null : JSON.stringify(Object.values(out[0])[0]);
      }

      return { ms: med(reps.slice(DROP)), rows, witness };
    });

  const a = ARM === 'temporal' ? { ms: 0, rows: 0, witness: null } : await timed(pair.numeric);
  const b = ARM === 'numeric' ? { ms: 0, rows: 0, witness: null } : await timed(pair.temporal);

  if (ARM !== undefined) {
    console.log(`ARM=${ARM} ${name} ms=${(ARM === 'numeric' ? a.ms : b.ms).toFixed(2)}`);
    continue;
  }

  // ⚠️ THE GUARD. Row counts must match, AND for a count pair the tally itself must — otherwise
  // the two predicates selected different sets and the ratio is between two questions.
  if (a.rows !== b.rows) {
    throw new Error(`PAIR ${name} ROW COUNTS DIFFER — numeric=${a.rows} temporal=${b.rows}.`);
  }

  if (name === 'filter' && a.witness !== b.witness) {
    throw new Error(
      `PAIR ${name} SELECTED DIFFERENT SETS — numeric tally=${a.witness} temporal=${b.witness}. ` +
        `The ratio would be between two different questions.`,
    );
  }

  console.log(
    `${name.padEnd(10)}${a.ms.toFixed(2).padStart(10)}${b.ms.toFixed(2).padStart(11)}` +
      `${`${(b.ms / a.ms).toFixed(2)}x`.padStart(9)}  ${a.rows} rows, witness ${a.witness}/${b.witness}  (${pair.note})`,
  );
}

// ─── THE GREMLIN HALF (item 1491) ────────────────────────────────────────────────────────────────
//
// Item 1490's defect was AST-SHAPED: the GQL parser lowers `DATE '…'` to a `lit` node holding a
// `Temporal`, and the planner's structural walk read that stored value as an expression. Gremlin
// has no expression tree — it dispatches a STEP LIST, and its comparison values arrive from the
// HOST already as values — so that mechanism is structurally absent and there is no literal-vs-param
// distinction to measure. Confirmed by reading: no `.kind` sniffing anywhere in `gremlin/src`.
//
// ⚠️ THAT IS AN ARGUMENT ABOUT ONE MECHANISM, NOT A PRICE. Gremlin could still pay a different
// temporal cost — `predicates.ts` routes every comparison through `isTemporal` twice before
// `temporalRelCmp` — and nothing had measured it, so the surface stays unpriced until it is.
//
// Same pairing discipline as the GQL half: each pair's two arms select the identical set, and the
// witness is printed so a divergence is visible rather than averaged in.
if (process.env.SKIP_GREMLIN === undefined && ARM === undefined) {
  const CUT_NUM = 3600;
  const CUT_T = dayOf(3600);

  const G_PAIRS = {
    gfilter: {
      note: 'has(gt) over 200,000 vertices, 10% selective — the predicate itself',
      numeric: traversal(V(), hasLabel('P'), has('num', gt(CUT_NUM)), count()),
      temporal: traversal(V(), hasLabel('P'), has('d', gt(CUT_T)), count()),
    },
    gorder: {
      note: 'order() over the selected tenth — the comparison path, which GQL pays 2.74x on',
      numeric: traversal(V(), hasLabel('P'), has('num', gt(CUT_NUM)), values('num'), order()),
      temporal: traversal(V(), hasLabel('P'), has('d', gt(CUT_T)), values('d'), order()),
    },
    gproject: {
      note: 'a bare read of every value — isolates VALUE cost from compare cost',
      numeric: traversal(V(), hasLabel('P'), values('num')),
      temporal: traversal(V(), hasLabel('P'), values('d')),
    },
  };

  console.log(`\nGREMLIN — same fixture, same pairs\n`);
  console.log(
    `${'pair'.padEnd(10)}${'numeric'.padStart(10)}${'temporal'.padStart(11)}${'ratio'.padStart(9)}  rows`,
  );

  // ⚠️ `GARM` is the Gremlin twin of `ARM`, and for the same reason: one profile window over both
  // arms attributes the numeric frames and the temporal frames to the same capture. With `GARM`
  // set, only that arm runs and only it is profiled.
  const { GARM } = process.env;

  if (GARM !== undefined && GARM !== 'numeric' && GARM !== 'temporal') {
    throw new Error(`GARM must be numeric|temporal, got ${GARM}`);
  }

  for (const [name, pair] of Object.entries(G_PAIRS)) {
    if (process.env.GPAIR !== undefined && process.env.GPAIR !== name) {
      continue;
    }

    const timedG = (plan) =>
      profileWindow(process.env.PROF_OUT, () => {
        const reps = [];
        let rows = 0;
        let witness = null;

        for (let r = 0; r < REPS; r += 1) {
          const t0 = performance.now();
          // ⚠️ `toArray(plan, graph)` IN THAT ORDER — item 1349 lost a round to the other order.
          const out = toArray(plan, graph);

          reps.push(performance.now() - t0);
          rows = Array.isArray(out) ? out.length : 1;
          witness = JSON.stringify(Array.isArray(out) ? out[0] : out);
        }

        return { ms: med(reps.slice(DROP)), rows, witness };
      });

    const blank = { ms: 0, rows: 0, witness: null };
    const a = GARM === 'temporal' ? blank : await timedG(pair.numeric);
    const b = GARM === 'numeric' ? blank : await timedG(pair.temporal);

    if (GARM !== undefined) {
      console.log(`GARM=${GARM} ${name} ms=${(GARM === 'numeric' ? a.ms : b.ms).toFixed(2)}`);
      continue;
    }

    if (a.rows !== b.rows) {
      throw new Error(`PAIR ${name} ROW COUNTS DIFFER — numeric=${a.rows} temporal=${b.rows}.`);
    }

    if (name === 'gfilter' && a.witness !== b.witness) {
      throw new Error(
        `PAIR ${name} SELECTED DIFFERENT SETS — numeric tally=${a.witness} temporal=${b.witness}.`,
      );
    }

    console.log(
      `${name.padEnd(10)}${a.ms.toFixed(2).padStart(10)}${b.ms.toFixed(2).padStart(11)}` +
        `${`${(b.ms / a.ms).toFixed(2)}x`.padStart(9)}  ${a.rows} rows, witness ${a.witness}/${b.witness}  (${pair.note})`,
    );
  }
}

console.log();
