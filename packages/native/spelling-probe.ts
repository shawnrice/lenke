/**
 * Equivalent spellings must cost the same — the TypeScript half.
 *
 * `crates/lenke-engine/examples/spelling_probe.rs` does this for the Rust engine:
 * for each group of queries that should be equivalent it prints the canonicalized
 * optimized plan and the measured time, and flags any group whose members
 * disagree. The TS engine has no plan to canonicalize, so time is the only signal
 * here — which makes this a PROBE, run deliberately, not a test with a timing
 * assertion in CI.
 *
 * It exists because this class keeps recurring and keeps being found by accident:
 * audit item 125 found an inline endpoint constraint costing 4x the equivalent
 * clause `WHERE`, and item 121 found a multi-pattern spelling costing 160x. Every
 * historical instance in CLAUDE.md returned the CORRECT answer, so no correctness
 * test could catch it.
 *
 *   cd packages/native && bun spelling-probe.ts
 *   SPELL_N=50000 bun spelling-probe.ts
 *
 * A group is flagged when its slowest member is more than SPELL_TOL (default 2x)
 * the fastest. Answers are compared too: a group whose members disagree on the
 * ANSWER is a correctness bug and is reported first.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 20_000);
const TOL = Number(process.env.SPELL_TOL ?? 2);
const REPS = Number(process.env.SPELL_REPS ?? 5);

const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["P","Q"]' : '["P"]'},"properties":{"k":${i % 50},"s":"s${i % 7}"}}`,
);

for (let e = 0; e < N * 3; e++) {
  lines.push(
    `{"type":"edge","id":"e${e}","labels":${e % 11 === 0 ? '["E","F"]' : '["E"]'},"from":"v${e % N}","to":"v${(e * 7919) % N}","properties":{"w":${e % 5}}}`,
  );
}

const g = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

/** Groups of spellings of ONE question. Every member must answer identically. */
const GROUPS: [string, readonly string[]][] = [
  [
    'node count: inline vs clause WHERE',
    [
      'MATCH (n:P {k: 2}) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, FAR endpoint filtered (item 125)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, START endpoint filtered',
    [
      'MATCH (a:P)-[:E]->(b) WHERE a.k = 2 RETURN count(*) AS c',
      'MATCH (a:P {k: 2})-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P WHERE a.k = 2)-[:E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    'operand order: $x = n.k vs n.k = $x',
    [
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 2 = n.k RETURN count(*) AS c',
    ],
  ],
  [
    'range operand order: 5 <= n.k vs n.k >= 5',
    [
      'MATCH (n:P) WHERE n.k >= 5 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 5 <= n.k RETURN count(*) AS c',
    ],
  ],
  [
    'OR vs IN',
    [
      'MATCH (n:P) WHERE n.k = 2 OR n.k = 7 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k IN [2, 7] RETURN count(*) AS c',
    ],
  ],
  [
    'NOT (=) vs <>',
    [
      'MATCH (n:P) WHERE NOT (n.k = 2) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k <> 2 RETURN count(*) AS c',
    ],
  ],
  [
    'edge type disjunction order',
    [
      'MATCH (a:P)-[:E|F]->(b) RETURN count(*) AS c',
      'MATCH (a:P)-[:F|E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    'direction: -> vs reversed <-',
    [
      'MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c',
      'MATCH (b:Q)<-[:E]-(a:P) RETURN count(*) AS c',
    ],
  ],
  [
    'two patterns vs two clauses (items 122/123)',
    [
      'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P {k: 1}) MATCH (b:P {k: 2}) RETURN count(*) AS c',
    ],
  ],
  [
    'label on start: redundant vs absent',
    ['MATCH (a:P)-[:E]->(b) RETURN count(*) AS c', 'MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  ],
  [
    'AND order',
    [
      "MATCH (n:P) WHERE n.k = 2 AND n.s = 's1' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.s = 's1' AND n.k = 2 RETURN count(*) AS c",
    ],
  ],
];

const timed = (q: string): { ms: number; answer: string } => {
  let best = Infinity;
  let answer = '';

  for (let i = 0; i < REPS; i++) {
    const t = performance.now();
    const rows = tsQuery(g, q);

    best = Math.min(best, performance.now() - t);
    answer = JSON.stringify(rows);
  }

  return { ms: best, answer };
};

console.log(`${N} vertices / ${N * 3} edges, min of ${REPS}, flagging spread > ${TOL}x\n`);

const wrong: string[] = [];
const slow: string[] = [];

for (const [name, spellings] of GROUPS) {
  const runs = spellings.map((q) => ({ q, ...timed(q) }));
  const answers = new Set(runs.map((r) => r.answer));
  const fastest = Math.min(...runs.map((r) => r.ms));
  const slowest = Math.max(...runs.map((r) => r.ms));
  const spread = slowest / Math.max(fastest, 0.01);
  let flag = '';

  if (answers.size > 1) {
    flag = 'ANSWERS DIFFER';
  } else if (spread > TOL) {
    flag = `${spread.toFixed(1)}x`;
  }

  console.log(`${flag.padStart(15)}  ${name}`);

  for (const r of runs) {
    console.log(`                   ${r.ms.toFixed(2).padStart(9)}ms  ${r.q}`);
  }

  if (answers.size > 1) {
    wrong.push(name);

    for (const r of runs) {
      console.log(`                   -> ${r.answer.slice(0, 80)}`);
    }
  } else if (spread > TOL) {
    slow.push(`${name} (${spread.toFixed(1)}x)`);
  }
}

console.log(
  `\n${wrong.length} group(s) disagree on the ANSWER${wrong.length > 0 ? `: ${wrong.join('; ')}` : ''}`,
);
console.log(
  `${slow.length} group(s) over ${TOL}x${slow.length > 0 ? `:\n  - ${slow.join('\n  - ')}` : ''}`,
);
