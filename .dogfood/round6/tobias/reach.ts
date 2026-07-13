import { query } from '@lenke/gql';
import {
  run,
  toArray,
  traversal,
  V,
  out,
  has,
  values,
  dedupe,
  repeat,
  count,
} from '@lenke/gremlin';

import { buildGrid, reachableWithin, reachableAll, bfsHops } from './graph';

const { g, adj } = buildGrid(6, 6);
const SRC = 'n_0_0';

function setEq(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

console.log('=== Reachability within N hops from', SRC, '===');
for (const N of [1, 2, 3, 5]) {
  const ref = reachableWithin(adj, SRC, N);

  // GQL variable-length: quantifier after arrow. Excludes zero-hop start with {1,N}.
  let gqlSet = new Set<string>();
  let gqlErr = '';
  try {
    const rows = query(
      g,
      `MATCH (a:Node {name:$s})-[:ROAD]->{1,${N}}(b) RETURN DISTINCT b.name AS n`,
      { s: SRC },
    );
    gqlSet = new Set(rows.map((r) => r.n as string));
  } catch (e) {
    gqlErr = String((e as Error).message);
  }

  // Gremlin: repeat(out).times(N).emit() collects each hop. .emit() is post-form (excludes level 0).
  let gremSet = new Set<string>();
  let gremErr = '';
  try {
    const res = toArray(
      traversal(
        V(),
        has('name', SRC),
        repeat(out('ROAD')).times(N).emit(),
        dedupe(),
        values('name'),
      ),
      g,
    );
    gremSet = new Set(res as string[]);
  } catch (e) {
    gremErr = String((e as Error).message);
  }

  const gqlOk = gqlErr ? 'ERR' : setEq(gqlSet, ref) ? 'OK' : 'MISMATCH';
  const gremOk = gremErr ? 'ERR' : setEq(gremSet, ref) ? 'OK' : 'MISMATCH';
  console.log(
    `N=${N} ref=${ref.size} | GQL=${gqlErr || gqlSet.size} [${gqlOk}] | Grem=${gremErr || gremSet.size} [${gremOk}]`,
  );
  if (gqlOk === 'MISMATCH') {
    const extra = [...gqlSet].filter((x) => !ref.has(x));
    const miss = [...ref].filter((x) => !gqlSet.has(x));
    console.log('   GQL extra:', extra.slice(0, 10), 'missing:', miss.slice(0, 10));
  }
  if (gremOk === 'MISMATCH') {
    const extra = [...gremSet].filter((x) => !ref.has(x));
    const miss = [...ref].filter((x) => !gremSet.has(x));
    console.log('   Grem extra:', extra.slice(0, 10), 'missing:', miss.slice(0, 10));
  }
}

console.log('\n=== Unbounded reachability from', SRC, '===');
{
  const ref = reachableAll(adj, SRC);
  // GQL: {1,} via +
  const rows = query(g, `MATCH (a:Node {name:$s})-[:ROAD]->+(b) RETURN DISTINCT b.name AS n`, {
    s: SRC,
  });
  const gqlSet = new Set(rows.map((r) => r.n as string));
  // Gremlin: repeat(out).emit() (no times) -- capped at 100 iters, but grid is a DAG shorter than that.
  const res = toArray(
    traversal(V(), has('name', SRC), repeat(out('ROAD')).emit(), dedupe(), values('name')),
    g,
  );
  const gremSet = new Set(res as string[]);
  console.log(
    `ref=${ref.size} | GQL=${gqlSet.size} [${setEq(gqlSet, ref) ? 'OK' : 'MISMATCH'}] | Grem=${gremSet.size} [${setEq(gremSet, ref) ? 'OK' : 'MISMATCH'}]`,
  );
}

console.log('\n=== Zero-hop semantics: does * include the start node? ===');
{
  const rowsStar = query(g, `MATCH (a:Node {name:$s})-[:ROAD]->*(b) RETURN DISTINCT b.name AS n`, {
    s: SRC,
  });
  const starSet = new Set(rowsStar.map((r) => r.n as string));
  const rowsPlus = query(g, `MATCH (a:Node {name:$s})-[:ROAD]->+(b) RETURN DISTINCT b.name AS n`, {
    s: SRC,
  });
  const plusSet = new Set(rowsPlus.map((r) => r.n as string));
  console.log(
    '* includes self?',
    starSet.has(SRC),
    '(size',
    starSet.size,
    ') | + includes self?',
    plusSet.has(SRC),
    '(size',
    plusSet.size,
    ')',
  );
}

console.log('\n=== Can A reach B? (boolean) ===');
{
  const pairs: [string, string][] = [
    ['n_0_0', 'n_5_5'], // yes
    ['n_5_5', 'n_0_0'], // no (DAG, only right/down)
    ['n_2_3', 'n_4_4'], // yes
    ['n_3_3', 'n_1_1'], // no
  ];
  for (const [s, d] of pairs) {
    const refReach = bfsHops(adj, s, d) !== Infinity;
    // GQL: existence via COUNT of var-length pattern
    const rows = query(
      g,
      `MATCH (a:Node {name:$s}) RETURN EXISTS { MATCH (a)-[:ROAD]->+(b:Node {name:$d}) } AS reach`,
      { s, d },
    );
    const gqlReach = rows[0].reach === true || rows[0].reach === 1;
    // Gremlin: does out-repeat reach d?
    const cnt = toArray(
      traversal(V(), has('name', s), repeat(out('ROAD')).emit().times(20), has('name', d), count()),
      g,
    )[0] as number;
    const gremReach = cnt > 0;
    console.log(
      `${s}->${d}: ref=${refReach} GQL=${gqlReach}[${gqlReach === refReach ? 'OK' : 'X'}] Grem=${gremReach}[${gremReach === refReach ? 'OK' : 'X'}]`,
    );
  }
}
