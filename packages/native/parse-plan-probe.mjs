/**
 * WHAT DOES PARSE+PLAN COST, AND WHO PAYS IT?
 *
 * `bench:usage` has carried the answer since item 662 without anyone pricing it: `write: append
 * node` runs at 128.6k ops/s and `write: append node [params]` at 512.8k — **4x between two
 * spellings of the same write**, in the UNINDEXED column where no seek can explain it. The cause is
 * in the harness, not the engine: the first row interpolates the loop counter into the query text,
 * so every call is a distinct string and misses the parse+plan cache (items 228/229), while the
 * param row's text is constant and hits it.
 *
 * That makes the 4x a measurement of parse+plan itself — about **5.8 us for a one-line INSERT** —
 * and it is paid by every application that builds query strings with literals in them, which is the
 * ordinary way people write queries before they learn about parameters. A cache cannot help: the
 * text is new every time by construction.
 *
 * ⚠️ THE CACHE IS THE THING TO DEFEAT, and defeating it is the whole design of this probe. Each
 * `fresh` arm mints a UNIQUE query string per rep (a comment carrying the rep number, so the text
 * differs while the parsed shape does not), and each `warm` arm reuses one string. The difference
 * between them is the cached cost; the `fresh` number is what an uncached caller pays.
 *
 *     node parse-plan-probe.mjs
 *     SHAPE=insert PROF_OUT=/tmp/x.cpuprofile node parse-plan-probe.mjs
 */
import { Graph } from '@lenke/core';
import { compile, parse, query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const REPS = Number(process.env.REPS ?? 20_000);
const DROP = Number(process.env.DROP ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ONLY = process.env.SHAPE;

const graph = new Graph();

for (let i = 0; i < 200; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 7, n: i } });
}

/** Query texts, each a shape a real caller writes. */
/**
 * ⚠️ A SECOND UNIQUIFIER, AND THE DIFFERENCE IS THE WHOLE MEASUREMENT (item 1502).
 *
 * `uniquify` appends a line comment, which makes the TEXT unique while leaving the AST identical —
 * built at item 1499 to defeat the parse cache. It also defeats AUTO-PARAMETERIZATION, because the
 * comment survives into the rewritten text, so the `fresh` arm cannot see that feature at all.
 *
 * `interpolate` is what a real application does: it varies a LITERAL. That text is unique for the
 * same reason, and it is the case auto-parameterization exists for — the rewritten text is constant
 * across reps, so it caches. Keeping BOTH arms is what separates the win from the cost: `fresh`
 * now measures what a literal-free cache miss pays for the attempt (one extra tokenize), and
 * `interp` measures what an interpolating caller gains.
 */
const INTERPOLATABLE = {
  insert: (i) => `INSERT (:Event {name: 'ev', score: ${i}, seq: 3})`,
  point: (i) => `MATCH (n:P) WHERE n.k = ${i} RETURN n.n AS v`,
  agg: (i) => `MATCH (n:P) WHERE n.k = ${i} RETURN n.k AS k, count(*) AS c`,
  longer: (i) =>
    `MATCH (u:P) WHERE u.k = ${i} AND u.n > 10 AND u.n < 100 OPTIONAL MATCH (u)-[:E]->(f:P) RETURN u.n AS n, count(f) AS fans ORDER BY n LIMIT 25`,
};

const SHAPES = {
  insert: "INSERT (:Event {name: 'ev', score: 7, seq: 3})",
  point: 'MATCH (n:P) WHERE n.k = 3 RETURN n.n AS v',
  hop: 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS v',
  agg: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  // A longer one, because parse cost should scale with text length and a 45-character query is not
  // what a real application sends.
  longer:
    'MATCH (u:P) WHERE u.k = 3 AND u.n > 10 AND u.n < 100 ' +
    'OPTIONAL MATCH (u)-[:E]->(f:P) RETURN u.n AS n, count(f) AS fans ORDER BY n LIMIT 25',
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

/** One round of `fn`, timed; `fn` is called REPS times with the rep index. */
const timeRound = (fn) => {
  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    fn(i);
  }

  return ((performance.now() - t0) * 1e6) / REPS; // ns per call
};

/**
 * ⚠️ A UNIQUE TEXT PER REP, and it has to leave the parsed SHAPE identical — otherwise the arms
 * compare different queries rather than cached against uncached. A trailing line comment does
 * exactly that: the lexer discards it, so every rep parses to the same AST from a different string.
 */
const uniquify = (text, i) => `${text} // u${i}`;

const names = ONLY === undefined ? Object.keys(SHAPES) : [ONLY];

for (const n of names) {
  if (SHAPES[n] === undefined) {
    throw new Error(`unknown SHAPE ${n}; have ${Object.keys(SHAPES).join(',')}`);
  }
}

// Prove the uniquifier does not change the parse, before any number is printed — otherwise the
// `fresh` arms could be measuring a different query and the whole probe would be void.
for (const [name, text] of Object.entries(SHAPES)) {
  const a = JSON.stringify(parse(text));
  const b = JSON.stringify(parse(uniquify(text, 1)));

  if (a !== b) {
    throw new Error(`UNIQUIFIER CHANGED THE PARSE for ${name} — the fresh arms would be void.`);
  }
}

console.log(`\nPARSE + PLAN — REPS=${REPS} ROUNDS=${ROUNDS} (median of rounds, ns per call)\n`);
console.log(
  `${'shape'.padEnd(8)}${'chars'.padStart(6)}${'parse'.padStart(9)}${'+plan'.padStart(9)}${'warm q'.padStart(9)}${'fresh q'.padStart(9)}${'interp'.padStart(9)}   fresh/warm  interp/warm`,
);

for (const name of names) {
  const text = SHAPES[name];
  const arms = {
    // 1. PARSE alone, uncached text.
    parse: () => timeRound((i) => parse(uniquify(text, i))),
    // 2. parse + COMPILE (the planner), uncached text.
    plan: () => timeRound((i) => compile(parse(uniquify(text, i)))),
    // 3. The whole call with a CONSTANT text — the cache hit path.
    warm: () => timeRound(() => query(graph, text)),
    // 4. The whole call with a UNIQUE text, made unique by a COMMENT — so it is unique to the
    //    parse cache AND to auto-parameterization. This is now the control for what a literal-free
    //    cache miss pays for the normalization attempt.
    fresh: () => timeRound((i) => query(graph, uniquify(text, i))),
    // 5. The whole call with a unique text made unique by a LITERAL — what an interpolating
    //    application actually sends, and the arm auto-parameterization is for.
    interp:
      INTERPOLATABLE[name] === undefined
        ? undefined
        : () => timeRound((i) => query(graph, INTERPOLATABLE[name](i))),
  };

  const out = {};

  for (const [arm, fn] of Object.entries(arms)) {
    if (fn === undefined) {
      out[arm] = Number.NaN;
      continue;
    }

    const rounds = [];

    for (let r = 0; r < ROUNDS; r += 1) {
      rounds.push(fn());
    }

    out[arm] = med(rounds.slice(DROP));
  }

  // ⚠️ `PROF_ARM` picks WHICH arm the profiler sees, and it matters: a window over `fresh` mixes
  // parse, plan and execute, so the planner's own frames are diluted by whatever the query does.
  // `PROF_ARM=plan` profiles parse+compile with no execution at all.
  const profArm = process.env.PROF_ARM ?? 'fresh';

  // eslint-disable-next-line no-await-in-loop
  await profileWindow(process.env.PROF_OUT, () => {
    for (let r = 0; r < 3; r += 1) {
      arms[profArm]();
    }

    return 0;
  });

  const interpCell = Number.isNaN(out.interp) ? '-' : out.interp.toFixed(0);
  const interpRatio = Number.isNaN(out.interp) ? '-' : `${(out.interp / out.warm).toFixed(1)}x`;

  console.log(
    `${name.padEnd(8)}${String(text.length).padStart(6)}${out.parse.toFixed(0).padStart(9)}` +
      `${out.plan.toFixed(0).padStart(9)}${out.warm.toFixed(0).padStart(9)}${out.fresh.toFixed(0).padStart(9)}` +
      `${interpCell.padStart(9)}` +
      `   ${`${(out.fresh / out.warm).toFixed(1)}x`.padEnd(10)}${interpRatio.padStart(11)}`,
  );
}

console.log();
