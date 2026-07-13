import { query, parseQuery } from '@lenke/gql';
import {
  toArray,
  traversal,
  V,
  out,
  has,
  values,
  path,
  repeat,
  until,
  shortestPath,
  ShortestPath,
  count,
  simplePath,
} from '@lenke/gremlin';

import { buildGrid, bfsHops, countPaths } from './graph';

const { g, adj } = buildGrid(5, 5);

console.log('=== Shortest hop-count path A->B ===');
const pairs: [string, string][] = [
  ['n_0_0', 'n_4_4'],
  ['n_0_0', 'n_2_3'],
  ['n_1_1', 'n_4_2'],
  ['n_0_0', 'n_0_4'],
];

for (const [s, d] of pairs) {
  const ref = bfsHops(adj, s, d);

  // Gremlin shortestPath step -> Vertex[][]
  let gremLen: number | string = '-';
  try {
    const res = toArray(
      traversal(V(), has('name', s), shortestPath().with(ShortestPath.target, has('name', d))),
      g,
    ) as any[][];
    // res is array of paths; each path is Vertex[]; hop length = nodes-1
    const lens = res.filter((p) => p.length).map((p) => p.length - 1);
    gremLen = lens.length ? Math.min(...lens) : Infinity;
  } catch (e) {
    gremLen = 'ERR:' + (e as Error).message.slice(0, 60);
  }

  // Gremlin manual: repeat(out).until(reached d).path(), take shortest — repeat is BFS-ish? verify
  let gremRepeatLen: number | string = '-';
  try {
    const res = toArray(
      traversal(
        V(),
        has('name', s),
        repeat(out('ROAD')).until(has('name', d)).times(20),
        has('name', d),
        path(),
      ),
      g,
    ) as any[][];
    const lens = res.map((p) => p.length - 1);
    gremRepeatLen = lens.length ? Math.min(...lens) : Infinity;
  } catch (e) {
    gremRepeatLen = 'ERR:' + (e as Error).message.slice(0, 60);
  }

  console.log(`${s}->${d}: ref=${ref} shortestPath=${gremLen} repeatUntil=${gremRepeatLen}`);
}

console.log('\n=== GQL SHORTEST path modifier probe ===');
for (const q of [
  `MATCH p = SHORTEST (a:Node {name:'n_0_0'})-[:ROAD]->+(b:Node {name:'n_4_4'}) RETURN p`,
  `MATCH p = ANY SHORTEST (a:Node {name:'n_0_0'})-[:ROAD]->+(b:Node {name:'n_4_4'}) RETURN p`,
  `MATCH ANY SHORTEST (a:Node {name:'n_0_0'})-[:ROAD]->+(b:Node {name:'n_4_4'}) RETURN b.name`,
  `MATCH p = (a:Node {name:'n_0_0'})-[:ROAD]->+(b:Node {name:'n_4_4'}) RETURN p`,
]) {
  try {
    const rows = query(g, q);
    console.log(
      'OK   :',
      q.slice(0, 60),
      '-> rows',
      rows.length,
      JSON.stringify(rows[0])?.slice(0, 80),
    );
  } catch (e) {
    console.log('ERR  :', q.slice(0, 60), '->', (e as Error).message.slice(0, 70));
  }
}

console.log(
  '\n=== GQL: shortest via min quantifier scan (find smallest N s.t. B reachable in N hops) ===',
);
{
  const [s, d] = ['n_0_0', 'n_4_4'];
  let found = Infinity;
  for (let N = 1; N <= 20; N++) {
    const rows = query(
      g,
      `MATCH (a:Node {name:$s})-[:ROAD]->{${N}}(b:Node {name:$d}) RETURN count(*) AS c`,
      { s, d },
    );
    if ((rows[0].c as number) > 0) {
      found = N;
      break;
    }
  }
  console.log(`min-N scan ${s}->${d}: ${found} (ref ${bfsHops(adj, s, d)})`);
}

console.log('\n=== Path enumeration count A->B ===');
{
  const [s, d] = ['n_0_0', 'n_3_3'];
  const ref = countPaths(adj, s, d);

  // Gremlin: all simple paths via repeat(out).until(d).path()
  const gremPaths = toArray(
    traversal(
      V(),
      has('name', s),
      repeat(out('ROAD')).until(has('name', d)).times(20),
      has('name', d),
      path(),
    ),
    g,
  ) as any[][];

  // GQL: count var-length paths reaching d (each distinct path is a row w/o DISTINCT)
  const gqlRows = query(
    g,
    `MATCH (a:Node {name:$s})-[:ROAD]->+(b:Node {name:$d}) RETURN count(*) AS c`,
    { s, d },
  );

  console.log(
    `ref paths=${ref} | Gremlin path()=${gremPaths.length} | GQL count(*)=${gqlRows[0].c}`,
  );
  // sanity: print one path node-name sequence
  if (gremPaths.length) {
    const one = gremPaths[0].map((v: any) => v.properties?.name ?? v.name ?? '?');
    console.log('  sample gremlin path:', one.join(' -> '));
  }
}
