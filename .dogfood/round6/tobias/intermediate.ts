// Prove GQL var-length WHERE filters only the ENDPOINT, not intermediates — a real capability gap
// for "route avoiding blocked nodes". src -> blocked -> dst; dst is 'safe', blocked is not.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { toArray, traversal, V, has, out, values, repeat, pipe, dedupe, eq } from '@lenke/gremlin';

const g = new Graph();
const mk = (name: string, safe: boolean) =>
  g.addVertex({ labels: ['Node'], properties: { name, safe } });
const src = mk('src', true);
const blocked = mk('blocked', false); // must NOT be traversed
const dst = mk('dst', true); // safe endpoint, but ONLY reachable via blocked
const detour = mk('detour', true); // safe, directly reachable
g.addEdge({ from: src, to: blocked, labels: ['R'] });
g.addEdge({ from: blocked, to: dst, labels: ['R'] });
g.addEdge({ from: src, to: detour, labels: ['R'] });

// Reference "safe corridor" reachable-set from src within 5 hops using only safe nodes: {detour}
// (dst is unreachable without passing through blocked)
const refSafe = new Set(['detour']);

// GQL: endpoint WHERE b.safe = true on a var-length pattern
const gqlRows = query(
  g,
  `MATCH (a:Node {name:'src'})-[:R]->{1,5}(b:Node WHERE b.safe = true) RETURN DISTINCT b.name AS n`,
);
const gqlSet = new Set(gqlRows.map((r) => r.n as string));

// Gremlin: filter EVERY hop to safe=true
const gremSet = new Set(
  toArray(
    traversal(
      V(),
      has('name', 'src'),
      repeat(pipe(out('R'), has('safe', eq(true))))
        .times(5)
        .emit(),
      dedupe(),
      values('name'),
    ),
    g,
  ) as string[],
);

const setEq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
console.log('ref safe-corridor:', [...refSafe]);
console.log(
  'GQL endpoint-only:',
  [...gqlSet],
  setEq(gqlSet, refSafe) ? '[OK]' : '[WRONG — includes dst reached THROUGH blocked]',
);
console.log('Gremlin per-hop  :', [...gremSet], setEq(gremSet, refSafe) ? '[OK]' : '[WRONG]');
