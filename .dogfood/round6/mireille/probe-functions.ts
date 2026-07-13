import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.addVertex({ labels: ['P'], properties: { x: 2 } });

// Run a scalar expression; return value or an error tag.
function ev(expr: string, params?: Record<string, unknown>): unknown {
  try {
    const rows = query(g, `MATCH (n:P) RETURN ${expr} AS r`, params);
    return rows[0]?.r;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name ?? 'Error'}: ${String(e?.message).slice(0, 60)}>`;
  }
}

const probes: Array<[string, string]> = [
  // trig / inverse trig — needed for geodesy
  ['sin(1)', 'trig'],
  ['cos(1)', 'trig'],
  ['tan(1)', 'trig'],
  ['cot(1)', 'trig'],
  ['asin(0.5)', 'inverse trig'],
  ['acos(0.5)', 'inverse trig'],
  ['atan(1)', 'inverse trig'],
  ['atan2(1, 1)', 'atan2 (2-arg) — bearing/haversine'],
  ['sinh(1)', 'hyperbolic'],
  ['cosh(1)', 'hyperbolic'],
  ['tanh(1)', 'hyperbolic'],
  // powers / roots
  ['sqrt(2)', 'root'],
  ['cbrt(8)', 'cube root'],
  ['power(2, 10)', 'power fn'],
  ['pow(2, 10)', 'pow alias'],
  ['2 ^ 10', 'caret operator'],
  ['exp(1)', 'exp'],
  ['ln(2.718281828459045)', 'ln'],
  ['log(2, 8)', 'log base'],
  ['log10(1000)', 'log10'],
  ['log2(8)', 'log2'],
  // rounding / integer ops
  ['abs(-5)', 'abs'],
  ['ceil(1.1)', 'ceil'],
  ['ceiling(1.1)', 'ceiling'],
  ['floor(1.9)', 'floor'],
  ['round(1.5)', 'round'],
  ['round(2.34567, 2)', 'round digits'],
  ['trunc(1.9)', 'trunc'],
  ['truncate(1.9)', 'truncate'],
  ['sign(-3)', 'sign'],
  ['mod(7, 3)', 'mod fn'],
  ['7 % 3', 'mod operator'],
  ['gcd(12, 8)', 'gcd'],
  ['lcm(4, 6)', 'lcm'],
  // constants
  ['pi()', 'pi'],
  ['e()', 'e'],
  ['tau()', 'tau'],
  ['radians(180)', 'radians'],
  ['degrees(pi())', 'degrees'],
  // aggregate-ish / stats (scalar context, expect unknown-fn)
  ['isnan(0.0/0.0)', 'isnan'],
  ['isinf(1.0)', 'isinf'],
];

console.log('=== SCALAR MATH FUNCTION AVAILABILITY ===');
for (const [expr, label] of probes) {
  const v = ev(expr);
  const ok = typeof v === 'string' && v.startsWith('ERR<') ? 'MISSING' : 'ok     ';
  console.log(`${ok}  ${expr.padEnd(28)} => ${JSON.stringify(v)}   [${label}]`);
}

// Aggregate availability
console.log('\n=== AGGREGATE AVAILABILITY ===');
const g2 = new Graph();
for (const v of [1, 2, 3, 4, 5]) g2.addVertex({ labels: ['N'], properties: { v } });
function agg(expr: string): unknown {
  try {
    return query(g2, `MATCH (n:N) RETURN ${expr} AS r`)[0]?.r;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 50)}>`;
  }
}
for (const a of [
  'count(n.v)',
  'sum(n.v)',
  'avg(n.v)',
  'min(n.v)',
  'max(n.v)',
  'collect_list(n.v)',
  'stddev(n.v)',
  'stddev_pop(n.v)',
  'stddev_samp(n.v)',
  'variance(n.v)',
  'var_pop(n.v)',
  'percentile_cont(n.v, 0.5)',
  'percentile_disc(n.v, 0.5)',
  'median(n.v)',
]) {
  const v = agg(a);
  const ok = typeof v === 'string' && v.startsWith('ERR<') ? 'MISSING' : 'ok     ';
  console.log(`${ok}  ${a.padEnd(28)} => ${JSON.stringify(v)}`);
}
