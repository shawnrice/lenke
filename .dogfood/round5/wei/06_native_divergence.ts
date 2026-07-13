// Cross-check astral-boundary string ops: pure-TS @lenke/gql vs native engine.
// README claims byte-identical parity for all string functions.
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { createEmptyGraph } from '@lenke/native';
import { createNodeBackend } from '@lenke/node/backend';

const tsG = new TsGraph();
const nG = createEmptyGraph(createNodeBackend());

function ts(expr: string): unknown {
  return tsQuery(tsG, `RETURN ${expr} AS r`)[0].r;
}
function nat(expr: string): unknown {
  const rows = nG.query(`RETURN ${expr} AS r`) as Array<Record<string, unknown>>;
  return rows[0].r;
}

const cases = [
  `substring('Rocket 🚀 go', 8, 1)`,
  `left('🚀x', 1)`,
  `right('x🚀', 1)`,
  `split('🚀', '')`,
  `reverse('a🚀b')`,
  `substring('🚀🚀', 2, 2)`,
  `char_length('🚀')`,
];

const cp = (s: unknown) =>
  typeof s === 'string'
    ? [...s].map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase()).join(' ')
    : '';

console.log('match | expr');
for (const c of cases) {
  let t: unknown, n: unknown;
  try {
    t = ts(c);
  } catch (e) {
    t = `<ERR ${(e as Error).message}>`;
  }
  try {
    n = nat(c);
  } catch (e) {
    n = `<ERR ${(e as Error).message}>`;
  }
  const tj = JSON.stringify(t),
    nj = JSON.stringify(n);
  console.log(`${tj === nj ? 'OK  ' : 'DIFF'} ${c}`);
  console.log(`      TS     = ${tj}   [${cp(t)}]`);
  console.log(`      NATIVE = ${nj}   [${cp(n)}]`);
}
