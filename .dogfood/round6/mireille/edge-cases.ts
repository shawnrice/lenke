import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
// A vertex carrying assorted numeric edge-case values.
g.addVertex({
  labels: ['N'],
  properties: {
    big: 9007199254740993, // 2^53+1, not representable exactly as f64
    bigfloat: 1e308,
    tiny: 5e-324, // Number.MIN_VALUE (denormal)
    negzero: -0,
    intish: 10,
    floatish: 10.0,
    manyDec: 0.1,
    neg: -7.5,
  },
});

function ev(expr: string, params?: Record<string, unknown>): unknown {
  try {
    return query(g, `MATCH (n:N) RETURN ${expr} AS r`, params)[0]?.r;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 60)}>`;
  }
}

const cases: Array<[string, unknown, Record<string, unknown>?]> = [
  // --- mod vs % on zero divisor: suspected divergence ---
  ['7 % 3', 7 % 3],
  ['mod(7, 3)', 7 % 3],
  ['7 % 0', 'data exception expected'],
  ['mod(7, 0)', 'mod(7,0) => ??? (JS: NaN)'],
  ['mod(-7, 3)', -7 % 3],
  ['-7 % 3', -7 % 3],
  // --- power / roots edge ---
  ['power(-8, 0.5)', (-8) ** 0.5], // NaN in JS
  ['power(0, 0)', 0 ** 0], // 1
  ['power(2, -1)', 2 ** -1],
  ['sqrt(-1)', Math.sqrt(-1)], // NaN
  // --- Infinity / NaN propagation from params ---
  ['$inf + 1', Infinity, { inf: Infinity }],
  ['$inf - $inf', NaN, { inf: Infinity }],
  ['$nan + 1', NaN, { nan: NaN }],
  ['$nan = $nan', 'NaN=NaN (three-valued?)', { nan: NaN }],
  ['abs($ninf)', Infinity, { ninf: -Infinity }],
  ['sign($nan)', NaN, { nan: NaN }],
  ['round($inf)', Infinity, { inf: Infinity }],
  ['floor($nan)', NaN, { nan: NaN }],
  // --- -0 handling ---
  ['n.negzero', 0],
  ['1 / n.negzero', 'div by -0 => ???'],
  ['sign(n.negzero)', 0],
  // --- big integers / precision loss ---
  ['n.big', 9007199254740993],
  ['n.big + 0', 9007199254740993],
  ['n.big - 9007199254740992', 1],
  ['n.bigfloat * 10', 1e309], // Infinity
  ['n.tiny / 2', 5e-324 / 2], // 0
  // --- integer vs float distinction ---
  ['n.intish', 10],
  ['n.floatish', 10.0],
  ['n.intish / 4', 10 / 4], // 2.5 or 2 ?
  ['n.intish / 3', 10 / 3],
  ['5 / 2', 5 / 2],
  ['4 / 2', 4 / 2],
  // --- rounding / many decimals ---
  ['n.manyDec + 0.2', 0.1 + 0.2], // 0.30000000000000004
  ['round(0.5)', 1],
  ['round(-0.5)', -1], // half away from zero
  ['round(2.5)', 3],
  ['round(1.005, 2)', 'famous fp: 1.005 rounds to ??'],
  ['ceil(-1.5)', Math.ceil(-1.5)],
  ['floor(-1.5)', Math.floor(-1.5)],
];

console.log('=== NUMERIC EDGE CASES (gql vs JS) ===');
for (const [expr, expected, params] of cases) {
  const got = ev(expr, params);
  const match =
    typeof expected === 'number' && typeof got === 'number'
      ? Object.is(got, expected)
        ? 'EXACT'
        : 'DIFF!'
      : '';
  console.log(
    `${match.padEnd(6)} ${expr.padEnd(26)} => ${JSON.stringify(got)}   (JS: ${JSON.stringify(expected)})`,
  );
}

// --- bigint at the value boundary ---
console.log('\n=== BIGINT storage/query ===');
try {
  const gb = new Graph();
  gb.addVertex({ labels: ['B'], properties: { v: 123n } });
  console.log(
    'stored bigint, read back:',
    JSON.stringify(query(gb, 'MATCH (b:B) RETURN b.v AS v')[0]),
  );
  console.log('bigint + 1:', JSON.stringify(query(gb, 'MATCH (b:B) RETURN b.v + 1 AS v')[0]));
} catch (e: any) {
  console.log('bigint ERR:', e?.code ?? e?.name, String(e?.message).slice(0, 80));
}
