import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
// population stored as bigint (a realistic choice for large counts)
for (const [nm, pop] of [
  ['A', 100n],
  ['B', 200n],
  ['C', 300n],
] as const) {
  g.addVertex({ labels: ['City'], properties: { nm, pop } });
}

function ev(expr: string, extra = ''): unknown {
  try {
    const r = query(g, `MATCH (c:City) ${extra} RETURN ${expr} AS r`)[0]?.r;
    return typeof r === 'bigint' ? `${r}n(bigint)` : `${JSON.stringify(r)}(${typeof r})`;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 50)}>`;
  }
}

console.log('=== BIGINT in operations/aggregates ===');
console.log('c.pop (raw)          =>', ev('c.pop'));
console.log('sum(c.pop)           =>', ev('sum(c.pop)'));
console.log('avg(c.pop)           =>', ev('avg(c.pop)'));
console.log('min(c.pop)           =>', ev('min(c.pop)'));
console.log('max(c.pop)           =>', ev('max(c.pop)'));
console.log('count(c.pop)         =>', ev('count(c.pop)'));
console.log('c.pop + 1            =>', ev('c.pop + 1'));
console.log('abs(c.pop)           =>', ev('abs(c.pop)'));
console.log('to_float(c.pop)      =>', ev('to_float(c.pop)'));
console.log('to_integer(c.pop)    =>', ev('to_integer(c.pop)'));
console.log('c.pop > 150 (filter) =>', ev('c.nm', 'WHERE c.pop > 150'));
console.log('c.pop = 200 (filter) =>', ev('c.nm', 'WHERE c.pop = 200'));
console.log('ORDER BY c.pop DESC  =>', ev('c.nm', 'WHERE true'));
try {
  const ordered = query(g, 'MATCH (c:City) RETURN c.nm AS r ORDER BY c.pop DESC');
  console.log('ORDER BY c.pop DESC  =>', JSON.stringify(ordered.map((x: any) => x.r)));
} catch (e: any) {
  console.log('ORDER BY bigint ERR:', e?.code ?? e?.name);
}
