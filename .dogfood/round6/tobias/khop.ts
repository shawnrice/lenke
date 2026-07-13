// k-hop neighborhoods, dedup, and intermediate-predicate filtering.
import { query } from '@lenke/gql';
import {
  toArray,
  traversal,
  V,
  has,
  out,
  values,
  dedupe,
  repeat,
  lt,
  pipe,
  filter,
} from '@lenke/gremlin';

import { buildGrid } from './graph';

const { g, adj } = buildGrid(6, 6);
const SRC = 'n_0_0';

function manhattan(name: string) {
  const [, r, c] = name.split('_').map(Number);
  return r + c;
}
const setEq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

console.log('=== Exactly-k-hop neighborhood (grid: = manhattan distance k) ===');
for (const k of [1, 2, 3, 4]) {
  // ref: monotone grid => a node has a length-k walk iff manhattan==k (and within bounds, reachable from 0,0)
  const ref = new Set(
    [...adj.keys()].filter(
      (n) => manhattan(n) === k && Number(n.split('_')[1]) <= 5 && Number(n.split('_')[2]) <= 5,
    ),
  );

  const gqlRows = query(
    g,
    `MATCH (a:Node {name:$s})-[:ROAD]->{${k}}(b) RETURN DISTINCT b.name AS n`,
    { s: SRC },
  );
  const gqlSet = new Set(gqlRows.map((r) => r.n as string));

  const gremSet = new Set(
    toArray(
      traversal(V(), has('name', SRC), repeat(out('ROAD')).times(k), dedupe(), values('name')),
      g,
    ) as string[],
  );
  console.log(
    `k=${k}: ref=${ref.size} GQL=${gqlSet.size}[${setEq(gqlSet, ref) ? 'OK' : 'X'}] Grem=${gremSet.size}[${setEq(gremSet, ref) ? 'OK' : 'X'}]`,
  );
}

console.log(
  '\n=== Intermediate-predicate filtering: reach within 6 hops using ONLY nodes with col<=2 ===',
);
{
  // ref BFS restricted to nodes with col<=2 (including src). exclude src.
  const allowed = (n: string) => Number(n.split('_')[2]) <= 2;
  const dist = new Map([[SRC, 0]]);
  let fr = [SRC];
  let h = 0;
  while (fr.length && h < 6) {
    h++;
    const nx: string[] = [];
    for (const u of fr)
      for (const { to } of adj.get(u) ?? []) {
        if (allowed(to) && !dist.has(to)) {
          dist.set(to, h);
          nx.push(to);
        }
      }
    fr = nx;
  }
  const ref = new Set(dist.keys());
  ref.delete(SRC);

  // Gremlin: repeat body filters each hop to col<=2
  const gremSet = new Set(
    toArray(
      traversal(
        V(),
        has('name', SRC),
        repeat(pipe(out('ROAD'), has('col', lt(3))))
          .times(6)
          .emit(),
        dedupe(),
        values('name'),
      ),
      g,
    ) as string[],
  );

  // GQL: can we constrain intermediates in a var-length pattern? Probe a couple of syntaxes.
  let gqlNote = '';
  let gqlSet = new Set<string>();
  try {
    const rows = query(
      g,
      `MATCH (a:Node {name:$s})-[:ROAD]->{1,6}(b:Node WHERE b.col <= 2) RETURN DISTINCT b.name AS n`,
      { s: SRC },
    );
    gqlSet = new Set(rows.map((r) => r.n as string));
    gqlNote = `endpoint-only filter -> ${gqlSet.size}`;
  } catch (e) {
    gqlNote = 'ERR ' + (e as Error).message.slice(0, 50);
  }

  console.log('ref (col<=2 corridor):', ref.size);
  console.log('Gremlin per-hop filter:', gremSet.size, setEq(gremSet, ref) ? '[OK]' : '[MISMATCH]');
  console.log(
    'GQL endpoint WHERE:',
    gqlNote,
    '(NOTE: filters only the endpoint b, NOT intermediates)',
  );
  // demonstrate GQL endpoint-only filter is DIFFERENT from corridor: it allows paths passing through col>2 then returning... but grid is monotone so col never decreases -> here it coincides. Show mismatch potential:
  console.log('  GQL set == ref?', setEq(gqlSet, ref) ? 'yes (coincides on monotone grid)' : 'no');
}
