/**
 * WHICH REALISTIC QUERY SHAPE IS EXPENSIVE? A per-family cost screen over item 1817's seventeen
 * workload families, at a size the differential fuzzer never runs them at (item 1820).
 *
 * WHY THIS IS NOT COVERED ALREADY. Every perf instrument in this directory measures a shape
 * SOMEONE ALREADY SUSPECTED — `runtime-profile-probe.mjs` has 40-odd hand-picked queries,
 * `isolated-row-bench.mjs` the rows a specific item was arguing about. Item 1817 built something
 * different for a correctness reason: seventeen families of REALISTIC query, drawn flat, each
 * asserted to parse, match rows and agree across engines. That corpus has never been timed. It is
 * the only list in the repo of "queries a user would actually write" that was not assembled by
 * someone hunting a particular lever, which makes it the one list a cost screen cannot be
 * circular about.
 *
 * THE FUZZER RUNS THEM ON SIX VERTICES, where everything is free. The families' literals
 * (`n IN [3,5,7,11,13,17,1,99]`, `x`, `s`, dates, `w`) are the fixture's value domain, so this
 * builds a LARGE graph over the SAME schema and the same domain — which keeps every predicate
 * selective rather than degenerate, and keeps every family non-vacuous at scale.
 *
 * WHAT THIS SCREEN CAN AND CANNOT SAY, because the obvious reading of its output is wrong.
 * Cost-per-ROW is NOT comparable across families: an aggregate family does O(N) work and returns
 * one row, so it will always look catastrophic per row and that means nothing. Cost per QUERY is
 * comparable only among families whose work is the same order. So the screen reports both and
 * FLAGS rather than concludes:
 *
 *   - a family whose ns/query is an outlier against the median is a NOMINATION, to be priced
 *     against its own floor the way `correlated-call-probe.mjs` prices a CALL against the MATCH it
 *     is equivalent to. It is not a finding.
 *   - a family returning ZERO rows at scale is a BROKEN SCREEN, not a fast family: its queries
 *     stopped matching when the fixture grew, so its time is the cost of finding nothing.
 *
 * AND THE EMPTY-SHARE COLUMN IS THE GUARD ON THIS WHOLE FILE. Item 1817's own worst bug was a
 * family that looked healthy on every axis while reaching the route it was written for zero times;
 * the analogue here is a family whose queries all return `[]` at 20,000 vertices, which would make
 * it the "fastest" family on the screen. Read `empty%` before any ns column.
 *
 *     bun workload-perf-screen.mjs
 *     NODES=200000 bun workload-perf-screen.mjs
 *     QUERIES=500 FAMILY=chain-rows bun workload-perf-screen.mjs
 */
import { spawnSync } from 'node:child_process';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { WORKLOAD_FAMILIES } from './src/workload-queries.js';

/**
 * 5,000 AND NOT 20,000, AND THE FIRST RUN IS WHY. At 20,000 vertices this screen hit
 * `timeout 600` and printed NOTHING — exit 124, with every family's row still buffered behind a
 * single report at the end. Two separate defects, both now fixed, and both the kind that make an
 * instrument useless rather than wrong:
 *
 *   - **A family is printed the moment it finishes**, so a run that dies still names every family
 *     that completed and, by omission, the one that did not. A screen whose output is one block at
 *     the end cannot localize a hang, which is the thing it most needs to do.
 *   - **A per-family BUDGET, checked between queries.** Some of these realistic shapes are
 *     quadratic by specification — a comma join over `(a:T), (b:T)` is 400,000,000 rows at 20,000
 *     vertices — so "slow" is the correct answer for them and the screen must record it and move
 *     on instead of hanging. It cannot interrupt a query already running (one thread), so a
 *     single pathological query can still overrun; that is what the outer cgroup+timeout wrapper
 *     is for (`dogfood-sim-resource-limits`).
 */
const NODES = Number(process.env.NODES ?? 5_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const QUERIES = Number(process.env.QUERIES ?? 100);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 15_000);
const ONLY = process.env.FAMILY;
const SEED = Number(process.env.SEED ?? 20_261_114);

/** The repo's lint-clean PRNG, so a run is reproducible from its seed. */
const mulberry32 = (seed) => {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * THE SAME VALUE DOMAIN AS THE FUZZER FIXTURE, not a fresh one — that is what keeps the
 * families' literals meaningful. `n` is drawn from the family pools' own numbers so `n = 5` and
 * `n IN [...]` select a real fraction; `x`, `s`, `nu`, `d`, `m` and the `w` edge property mirror
 * the fixture's shapes, including the SPARSE ones (`nu` null on some vertices, `st` absent on
 * most), because an absent property is a different code path from a present one.
 *
 * One vertex in six also carries `U`, matching the fixture's ratio — with every vertex
 * single-labelled, "match any label" and "match the first label" are indistinguishable, and the
 * label-elision rungs would be measured on a graph that cannot tell them apart.
 */
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const labels = i % 6 === 2 ? ['T', 'U'] : ['T'];
    const properties = {
      n: N_POOL[i % N_POOL.length],
      x: X_POOL[i % X_POOL.length],
      s: S_POOL[i % S_POOL.length],
      nu: i % 3 === 1 ? null : (i % 9) + 1,
      d: { '@date': DATES[i % DATES.length] },
      m: { k: i % 7, j: `q${i % 5}` },
    };

    // `st` on a third of the vertices only: a SPARSE string, as in the fixture.
    if (i % 3 === 0) {
      properties.st = `p${i % 11}`;
    }

    g.addVertex({ id: String(i + 1), labels, properties });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      // Splits on the REPEAT INDEX, which is CLAUDE.md's fix for the `(a*k+b) % N` degeneracy:
      // without it one vertex's FANOUT edges all land on the same target, every k-hop count is
      // `F^k * N` by construction, and the graph is FUNCTIONAL while every degree looks perfect.
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      // Both edge types, in the fixture's proportion, so `[:E|F]` and `[:E]` differ here.
      labels: hop % 4 === 3 ? ['F'] : ['E'],
      properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
    });
  }

  return g;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const g = build();

console.log(
  `# workload-perf-screen NODES=${NODES} FANOUT=${FANOUT} queries/family=${QUERIES} ` +
    `rounds=${ROUNDS} seed=${SEED}`,
);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}\n`);

/** One Workload per family, so each family's generator is driven independently of the others. */
const byFamily = new Map();

for (const gen of WORKLOAD_FAMILIES) {
  const name = gen(() => 0).family;

  if (!byFamily.has(name)) {
    byFamily.set(name, []);
  }

  byFamily.get(name).push(gen);
}

const names = [...byFamily.keys()].sort((a, b) => a.localeCompare(b));

/**
 * ONE CHILD PROCESS PER FAMILY WHEN NO `FAMILY` IS GIVEN, and the second run is why. With every
 * family in one process the run died at `exit 137` — the cgroup OOM kill — on the family after
 * `in-list`, taking the seven already-measured families' output with it. A comma join over
 * `(a:T), (b:T)` materializes 25,000,000 rows at 5,000 vertices, so that family is SUPPOSED to
 * die; what is not acceptable is that it deletes the rest of the screen.
 *
 * AND NO `try/catch` CAN FIX THAT, which is the point worth keeping: an OOM kill and a timeout
 * arrive as a SIGNAL to the process, not as a JavaScript exception, so the only way to survive one
 * is for the measurement to be in a process you are willing to lose. It also gets item 762's rule
 * for free (one shape per process, so no other family's shape pollutes the dispatch sites).
 *
 * A child that dies is REPORTED with its signal and the screen continues — a family that cannot be
 * measured at this size is a result about that family, not a gap in the run.
 */
if (ONLY === undefined && process.env.SCREEN_CHILD !== '1') {
  console.log('# one child process per family (a family that OOMs or hangs must not take the run)');
  console.log(
    `${'family'.padEnd(16)}${'ms'.padStart(9)}${'ns/query'.padStart(12)}${'ns/row'.padStart(10)}` +
      `${'rows'.padStart(11)}${'empty%'.padStart(8)}${'err'.padStart(6)}   flag`,
  );

  for (const name of names) {
    const r = spawnSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, FAMILY: name, SCREEN_CHILD: '1' },
      encoding: 'utf8',
      timeout: Number(process.env.CHILD_TIMEOUT_MS ?? 120_000),
    });

    const line = (r.stdout ?? '')
      .split('\n')
      .find((l) => l.startsWith(name.padEnd(16)) || l.startsWith(`${name} `));

    if (line !== undefined) {
      console.log(line);
    } else {
      const why =
        r.signal !== null && r.signal !== undefined
          ? `KILLED BY ${r.signal}`
          : `exit ${r.status ?? '?'}`;

      console.log(
        `${name.padEnd(16)}${'-'.padStart(9)}${'-'.padStart(12)}${'-'.padStart(10)}` +
          `${'-'.padStart(11)}${'-'.padStart(8)}${'-'.padStart(6)}   ` +
          `NOT MEASURABLE AT THIS SIZE — ${why}`,
      );
    }
  }

  console.log('\n# ns/row is NOT comparable across families (an aggregate returns 1 row for');
  console.log('#    O(N) work). A NOMINATION needs its own floor before it is a finding.');
  process.exit(0);
}

const rows = [];

console.log(
  `${'family'.padEnd(16)}${'ms'.padStart(9)}${'ns/query'.padStart(12)}${'ns/row'.padStart(10)}` +
    `${'rows'.padStart(11)}${'empty%'.padStart(8)}${'err'.padStart(6)}   flag`,
);

for (const name of names) {
  if (ONLY !== undefined && ONLY !== name) {
    continue;
  }

  const gens = byFamily.get(name);
  const workloads = [];
  const r = mulberry32(SEED ^ (name.length * 2_654_435_761));

  for (let i = 0; i < QUERIES; i += 1) {
    workloads.push(gens[i % gens.length](r));
  }

  // ERRORS ARE COUNTED, NOT SWALLOWED. A family that throws at scale would otherwise read as
  // the fastest one on the screen — the same failure mode as a family returning [].
  let errors = 0;
  let empties = 0;
  let totalRows = 0;
  let done = 0;
  let overBudget = false;
  const perRound = [];

  for (let round = 0; round < ROUNDS && !overBudget; round += 1) {
    const t0 = performance.now();

    errors = 0;
    empties = 0;
    totalRows = 0;
    done = 0;

    for (const w of workloads) {
      try {
        const out = query(g, w.text, w.params);

        totalRows += out.length;

        if (out.length === 0) {
          empties += 1;
        }
      } catch {
        errors += 1;
      }

      done += 1;

      if (performance.now() - t0 > BUDGET_MS) {
        overBudget = true;
        break;
      }
    }

    perRound.push(performance.now() - t0);
  }

  const ms = median(perRound);
  const x = {
    name,
    ms,
    done,
    overBudget,
    nsPerQuery: (ms * 1e6) / done,
    nsPerRow: totalRows === 0 ? Number.NaN : (ms * 1e6) / totalRows,
    totalRows,
    emptyPct: (100 * empties) / done,
    errors,
  };

  rows.push(x);

  const flags = [];

  if (x.overBudget) {
    flags.push(`OVER BUDGET — ${done}/${QUERIES} queries in ${BUDGET_MS} ms`);
  }

  if (x.errors > 0) {
    flags.push(`${x.errors} ERRORS — screen is broken for this family`);
  }

  if (x.totalRows === 0) {
    flags.push('ZERO ROWS — vacuous at this size, not fast');
  } else if (x.emptyPct > 50) {
    flags.push(`${x.emptyPct.toFixed(0)}% empty — mostly measuring a miss`);
  }

  const cells = [
    x.name.padEnd(16),
    x.ms.toFixed(1).padStart(9),
    x.nsPerQuery.toFixed(0).padStart(12),
    (Number.isNaN(x.nsPerRow) ? '-' : x.nsPerRow.toFixed(0)).padStart(10),
    String(x.totalRows).padStart(11),
    x.emptyPct.toFixed(0).padStart(8),
    String(x.errors).padStart(6),
  ].join('');

  // PRINTED HERE, not collected for a report at the end — see the BUDGET note at the top.
  console.log(`${cells}   ${flags.join('; ')}`);
}

const med = median(rows.filter((x) => !x.overBudget).map((x) => x.nsPerQuery));

console.log(`\n# median ns/query across families that finished: ${med.toFixed(0)}`);
console.log('# NOMINATIONS (ns/query more than 3x that median), worst first:\n');

for (const x of rows.sort((a, b) => b.nsPerQuery - a.nsPerQuery)) {
  if (x.overBudget || x.nsPerQuery > 3 * med) {
    const why = x.overBudget
      ? `OVER BUDGET after ${x.done}/${QUERIES} queries`
      : `${(x.nsPerQuery / med).toFixed(1)}x the median`;

    console.log(`  ${x.name.padEnd(16)} ${x.nsPerQuery.toFixed(0).padStart(12)} ns/query  ${why}`);
  }
}

console.log('# ns/row is NOT comparable across families (an aggregate returns 1 row for O(N)');
console.log('#    work). A NOMINATION needs its own floor before it is a finding.');
