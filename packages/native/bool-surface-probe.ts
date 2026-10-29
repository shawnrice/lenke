/**
 * Do items 1172/1175's boolean arms reach the GREMLIN surface too? (item 1178)
 *
 * Both wins are in `exec/fastpath.rs` and `exec/order.rs`, which serve one `ir::Plan` — so in
 * principle a Gremlin traversal that lowers to the same plan gets them free. In principle is not
 * a measurement: items 1159/1160 found a gap of exactly this shape, where the same engine answered
 * an untyped hop count instantly through Gremlin and not at all through GQL. One engine, one
 * question, two surface languages, two different costs.
 *
 * So this asks the GQL spelling and the Gremlin spelling of each win side by side, with the
 * numeric spelling of the same query as the control — it reaches a DIFFERENT arm, so it should
 * cost the same in both surfaces whatever the boolean rows do.
 *
 *   cd packages/native && bun bool-surface-probe.ts
 */
import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.BS_N ?? 200_000);
const REPS = Number(process.env.BS_REPS ?? 9);

const doc = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90},"flag":${i % 2 === 0}}}`,
).join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const g = graphFromNdjson(createFfiEngineBackend(LIB), doc);

const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const time = (run: () => unknown): { ms: number; answer: string } => {
  const answer = JSON.stringify(run());
  const s: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    run();
    s.push(performance.now() - t);
  }

  return { ms: med(s), answer };
};

console.log(`\n# ${N} nodes, native engine, median of ${REPS} dropping 3\n`);
console.log('  question                        surface      ms       answer');

const rows: [string, string, () => unknown][] = [
  // THE EXTREMUM (item 1172, ~3107x natively through GQL).
  ['min over a BOOLEAN', 'gql', () => g.query('MATCH (a:Person) RETURN min(a.flag) AS c')],
  ['min over a BOOLEAN', 'gremlin', () => g.gremlin("g.V().values('flag').min()")],
  ['min over a NUMBER      [ctl]', 'gql', () => g.query('MATCH (a:Person) RETURN min(a.age) AS c')],
  ['min over a NUMBER      [ctl]', 'gremlin', () => g.gremlin("g.V().values('age').min()")],
  // THE TOP-K (item 1175, ~5851x natively through GQL).
  [
    'ORDER BY BOOLEAN LIMIT 5',
    'gql',
    () => g.query('MATCH (a:Person) RETURN a.flag AS v ORDER BY a.flag LIMIT 5'),
  ],
  ['ORDER BY BOOLEAN LIMIT 5', 'gremlin', () => g.gremlin("g.V().values('flag').order().limit(5)")],
  [
    'ORDER BY NUMBER LIMIT 5  [ctl]',
    'gql',
    () => g.query('MATCH (a:Person) RETURN a.age AS v ORDER BY a.age LIMIT 5'),
  ],
  [
    'ORDER BY NUMBER LIMIT 5  [ctl]',
    'gremlin',
    () => g.gremlin("g.V().values('age').order().limit(5)"),
  ],
];

for (const [label, surface, run] of rows) {
  try {
    const { ms, answer } = time(run);
    const short = answer.length > 24 ? `${answer.slice(0, 21)}...` : answer;

    console.log(
      `  ${label.padEnd(31)} ${surface.padEnd(9)} ${ms.toFixed(2).padStart(7)}   ${short}`,
    );
  } catch (e) {
    const code = String((e as { code?: string }).code ?? (e as Error).message).slice(0, 30);

    console.log(`  ${label.padEnd(31)} ${surface.padEnd(9)}     ERR   ${code}`);
  }
}
