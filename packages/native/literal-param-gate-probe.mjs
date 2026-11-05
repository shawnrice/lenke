/**
 * THE GATE ON ITEM 1499's AUTO-PARAMETERIZATION LEVER: which literal positions can be turned into
 * parameters without changing anything?
 *
 * Item 1499 priced the lever at 3.1-6.9x (parse+plan is that multiple of a cheap query's execution,
 * and an interpolating caller pays it every call because the cache keys on text). Item 1500 then
 * showed the planner has no hot spot, so skipping parse+plan is the only large win left. The
 * blocker is not performance, it is that **the planner reads literal VALUES**, and a literal lifted
 * into a parameter is invisible to it at plan time.
 *
 * This probe is the gate, in the shape item 1496 used for the adjacency change: enumerate the
 * positions a literal can occupy, and for each one compare the literal spelling against the
 * parameter spelling on BOTH axes —
 *
 *   ANSWER   they must return the same rows, or the rewrite is a wrong-answer bug;
 *   ROUTE    they must cost the same, or the rewrite silently loses a fast path.
 *
 * ⚠️ THE ROUTE AXIS IS THE WHOLE POINT, and it is why this cannot be a unit test. Both spellings
 * answering identically is necessary and not sufficient: every index-seeding defect in this engine's
 * history returned the correct answer and cost 100-300x (CLAUDE.md's named class). A position where
 * the param spelling is much slower is a position auto-parameterization must leave alone.
 *
 * Known exceptions going in, from the audit rather than from this probe — each is here as a row so
 * the probe is checked against facts already established:
 *   - `{k: null}` means IS NULL for an INLINE constraint (item 260), where `k = $p` with a null
 *     param does not. Parameterizing a null literal changes SEMANTICS.
 *   - `LIMIT`/`SKIP` values are read by `topKPlan` at plan time (item 1064).
 *
 *     NODES=200000 node literal-param-gate-probe.mjs
 *     CASE=limit node literal-param-gate-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);
const INDEXED = process.env.INDEXED !== '0';
const ONLY = process.env.CASE;

const build = () => {
  const g = new Graph();
  const ids = [];

  for (let i = 0; i < NODES; i += 1) {
    ids.push(`v${i}`);
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: {
        k: i % 50,
        s: `s${i % 97}`,
        flag: i % 5 !== 0,
        // A tenth of the rows carry a null, so the null-literal rows have something to find.
        maybe: i % 10 === 0 ? null : i,
      },
    });
  }

  for (let e = 0; e < NODES; e += 1) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(ids[(e * 7919) % NODES]),
      to: g.getVertexById(ids[(e * 104_729) % NODES]),
    });
  }

  // ⚠️ INDEXED BY DEFAULT, because the seeding routes are exactly where a literal-vs-param
  // difference would hide — an unindexed graph scans either way and the probe would be blind to the
  // class it exists to check (item 578's lesson about the spelling probe having no index).
  if (INDEXED) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });
  }

  return g;
};

const graph = build();

/**
 * Each case: the same question spelled with a LITERAL and with a PARAM.
 *
 * The param values are chosen to equal the literals exactly, so a divergence is the engine's and
 * not the fixture's.
 */
const CASES = {
  'clause =': [
    'MATCH (n:P) WHERE n.k = 7 RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.k = $v RETURN count(*) AS c',
    { v: 7 },
  ],
  'clause >': [
    'MATCH (n:P) WHERE n.k > 7 RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.k > $v RETURN count(*) AS c',
    { v: 7 },
  ],
  'clause string': [
    "MATCH (n:P) WHERE n.s = 's5' RETURN count(*) AS c",
    'MATCH (n:P) WHERE n.s = $v RETURN count(*) AS c',
    { v: 's5' },
  ],
  'clause bool': [
    'MATCH (n:P) WHERE n.flag = true RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.flag = $v RETURN count(*) AS c',
    { v: true },
  ],
  inline: [
    'MATCH (n:P {k: 7}) RETURN count(*) AS c',
    'MATCH (n:P {k: $v}) RETURN count(*) AS c',
    { v: 7 },
  ],
  'inline string': [
    "MATCH (n:P {s: 's5'}) RETURN count(*) AS c",
    'MATCH (n:P {s: $v}) RETURN count(*) AS c',
    { v: 's5' },
  ],
  'inline WHERE': [
    'MATCH (n:P WHERE n.k = 7) RETURN count(*) AS c',
    'MATCH (n:P WHERE n.k = $v) RETURN count(*) AS c',
    { v: 7 },
  ],
  'two conjuncts': [
    'MATCH (n:P) WHERE n.k = 7 AND n.flag = true RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.k = $v AND n.flag = $f RETURN count(*) AS c',
    { v: 7, f: true },
  ],
  'IN list': [
    'MATCH (n:P) WHERE n.k IN [7, 8] RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.k IN [$a, $b] RETURN count(*) AS c',
    { a: 7, b: 8 },
  ],
  'hop start': [
    'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 7 RETURN count(*) AS c',
    'MATCH (a:P)-[:E]->(b:P) WHERE a.k = $v RETURN count(*) AS c',
    { v: 7 },
  ],
  'hop far': [
    'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c',
    'MATCH (a:P)-[:E]->(b:P) WHERE b.k = $v RETURN count(*) AS c',
    { v: 7 },
  ],
  projection: [
    'MATCH (n:P) WHERE n.k = 7 RETURN n.k + 1 AS v',
    'MATCH (n:P) WHERE n.k = $v RETURN n.k + 1 AS v',
    { v: 7 },
  ],
  // ── The known exceptions, as rows ──────────────────────────────────────────────────────────
  'LIMIT (exception)': [
    'MATCH (n:P) WHERE n.k > 0 RETURN n.k AS v ORDER BY v LIMIT 10',
    'MATCH (n:P) WHERE n.k > 0 RETURN n.k AS v ORDER BY v LIMIT $l',
    { l: 10 },
  ],
  'inline null (exception)': [
    'MATCH (n:P {maybe: null}) RETURN count(*) AS c',
    'MATCH (n:P {maybe: $v}) RETURN count(*) AS c',
    { v: null },
  ],
  // ⚠️ DIFFERENT OPERATORS BY DESIGN — this row is expected to DIFFER and exists to pin why.
  // `IS NULL` is a null TEST; `= $v` with a null param is a comparison that yields UNKNOWN and
  // matches nothing. So `IS NULL` has no parameterized spelling at all, which is a stronger
  // statement than "do not parameterize a null literal": there is nothing to rewrite it into.
  'IS NULL vs = $null (MUST differ)': [
    'MATCH (n:P) WHERE n.maybe IS NULL RETURN count(*) AS c',
    'MATCH (n:P) WHERE n.maybe = $v RETURN count(*) AS c',
    { v: null },
  ],
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const timed = (text, params) => {
  const reps = [];
  let out = null;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = query(graph, text, params);
    reps.push(performance.now() - t0);
  }

  return { ms: med(reps.slice(DROP)), answer: JSON.stringify(out) };
};

const names =
  ONLY === undefined ? Object.keys(CASES) : Object.keys(CASES).filter((n) => n.includes(ONLY));

console.log(
  `\nLITERAL vs PARAM — NODES=${NODES} indexed=${INDEXED ? 'k,s' : 'none'} REPS=${REPS}\n`,
);
console.log(
  `${'case'.padEnd(26)}${'literal'.padStart(10)}${'param'.padStart(10)}${'ratio'.padStart(9)}  answers`,
);

const diverged = [];
const slow = [];
const nearFloor = [];
/** Below this, a ratio is clock resolution rather than a route difference — item 1461's floor. */
const FLOOR_MS = Number(process.env.FLOOR_MS ?? 1);

for (const name of names) {
  const [litText, parText, params] = CASES[name];
  const lit = timed(litText, undefined);
  const par = timed(parText, params);
  const same = lit.answer === par.answer;
  const ratio = par.ms / lit.ms;

  if (!same) {
    diverged.push(name);
  } else if (ratio > 1.5 || ratio < 1 / 1.5) {
    // ⚠️ A sub-millisecond pair is clock, not a route. `two conjuncts` read 0.54x at NODES=200000
    // and 1.25x at 1,000,000 for exactly this reason (item 1501).
    (Math.max(lit.ms, par.ms) < FLOOR_MS ? nearFloor : slow).push(`${name} (${ratio.toFixed(2)}x)`);
  }

  console.log(
    `${name.padEnd(26)}${lit.ms.toFixed(2).padStart(10)}${par.ms.toFixed(2).padStart(10)}` +
      `${`${ratio.toFixed(2)}x`.padStart(9)}  ${same ? 'same' : `DIFFER lit=${lit.answer.slice(0, 28)} par=${par.answer.slice(0, 28)}`}`,
  );
}

console.log();
console.log(
  diverged.length === 0
    ? 'ANSWERS: every case agrees.'
    : `⚠️ ANSWERS DIFFER in ${diverged.length} case(s) — auto-parameterization must NOT touch: ${diverged.join(', ')}`,
);
console.log(
  slow.length === 0
    ? `ROUTES: no case outside 1.5x above the ${FLOOR_MS}ms floor.`
    : `⚠️ ROUTE DIFFERS (>1.5x) in ${slow.length} case(s): ${slow.join(', ')}`,
);

if (nearFloor.length > 0) {
  console.log(
    `${nearFloor.length} case(s) outside 1.5x but UNDER the ${FLOOR_MS}ms floor — not results, raise NODES: ${nearFloor.join(', ')}`,
  );
}

if (slow.length > 0) {
  console.log('\n  ⚠️ CONFIRM EACH ALONE, AT HIGH REPS, BEFORE BELIEVING IT. Item 1501 had three');
  console.log('  flags and all three were the instrument: `two conjuncts` was the floor (0.54x at');
  console.log(
    '  200k, 1.25x at 1M); `hop start` swung 3.03x / 0.73x / 0.32x across isolated rounds;',
  );
  console.log(
    '  and `inline`\u2019s LITERAL arm is BIMODAL (0.95 / 3.42 / 1.21 / 0.98 ms at REPS=25),',
  );
  console.log('  so its 0.53x readings were the slow mode and three of four rounds read ~1.0x.');

  for (const f of slow) {
    console.log(
      `    NODES=1000000 REPS=25 DROP=5 CASE='${f.split(' (')[0]}' node literal-param-gate-probe.mjs`,
    );
  }
}

console.log();
