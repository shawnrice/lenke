import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.addVertex({ labels: ['N'], properties: { small: 5 } });

function ev(expr: string): unknown {
  try {
    const r = query(g, `MATCH (n:N) RETURN ${expr} AS r`)[0]?.r;
    return typeof r === 'bigint' ? `${r}n` : r;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 55)}>`;
  }
}

console.log('=== INTEGER LITERAL BOUNDARY ===');
for (const lit of [
  '9007199254740991', // 2^53-1 MAX_SAFE_INTEGER
  '9007199254740992', // 2^53
  '9007199254740993', // 2^53+1
  '-9007199254740991',
  '-9007199254740992',
  '18446744073709551615', // u64 max
  '99999999999999999999999999', // huge
]) {
  console.log(`${lit.padEnd(28)} => ${JSON.stringify(ev(lit))}`);
}

console.log('\n=== FLOAT LITERAL for large magnitudes ===');
for (const lit of ['9007199254740992.0', '1e20', '9.007199254740992e15']) {
  console.log(`${lit.padEnd(28)} => ${JSON.stringify(ev(lit))}`);
}

console.log('\n=== BIGINT stored value round-trip ===');
const gb = new Graph();
gb.addVertex({ labels: ['B'], properties: { v: 9007199254740993n, small: 42n } });
function evb(expr: string): unknown {
  try {
    const r = query(gb, `MATCH (b:B) RETURN ${expr} AS r`)[0]?.r;
    return typeof r === 'bigint' ? `${r}n (bigint)` : `${JSON.stringify(r)} (${typeof r})`;
  } catch (e: any) {
    return `ERR<${e?.code ?? e?.name}: ${String(e?.message).slice(0, 55)}>`;
  }
}
for (const expr of ['b.v', 'b.small', 'b.small + 1', 'b.v + 0', 'b.small * 2', 'abs(b.small)']) {
  console.log(`${expr.padEnd(16)} => ${evb(expr)}`);
}
