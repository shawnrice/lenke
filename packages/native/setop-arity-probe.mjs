/**
 * Does either engine reject UNEQUAL DEGREE in a set operation? (item 1562)
 *
 * ISO/IEC 39075 requires the operands of `UNION`/`EXCEPT`/`INTERSECT` to have the same degree. The
 * TS engine accepts unequal degree and answers with the left side's names, which item 1562 found
 * because a mutant that assumed the opposite survived the suite. Whether that is a DIVERGENCE or a
 * shared non-conformance decides where it belongs, so this asks both engines the same questions.
 *
 * Run with BUN, not node: it imports the test-support harness from `src`, which is not published
 * to `dist`.
 *
 * Not a test: it records what is, for an entry. A test would have to assert one behaviour as
 * correct, and which one is correct is the open question.
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NDJSON = [
  JSON.stringify({ type: 'node', id: 'v1', labels: ['P'], properties: { k: 1, s: 'a' } }),
  JSON.stringify({ type: 'node', id: 'v2', labels: ['P'], properties: { k: 2, s: 'b' } }),
].join('\n');

const CASES = {
  'EXCEPT 1 vs 2': 'MATCH (n:P) RETURN n.k AS a EXCEPT MATCH (n:P) RETURN n.k AS a, n.s AS b',
  'EXCEPT 2 vs 1': 'MATCH (n:P) RETURN n.k AS a, n.s AS b EXCEPT MATCH (n:P) RETURN n.k AS a',
  'UNION 1 vs 2': 'MATCH (n:P) RETURN n.k AS a UNION MATCH (n:P) RETURN n.k AS a, n.s AS b',
  'INTERSECT 1 vs 2': 'MATCH (n:P) RETURN n.k AS a INTERSECT MATCH (n:P) RETURN n.k AS a, n.s AS b',
  'EXCEPT equal (control)':
    'MATCH (n:P) RETURN n.k AS a EXCEPT MATCH (n:P) WHERE n.k = 1 RETURN n.k AS a',
};

if (!nativeReady) {
  console.log('native lib missing — build with --features capi first');
  process.exit(1);
}

const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

const run = (f) => {
  try {
    return `ok  ${JSON.stringify(f())}`;
  } catch (e) {
    return `ERR ${String(e.message ?? e).slice(0, 56)}`;
  }
};

for (const [name, text] of Object.entries(CASES)) {
  const ts = run(() => tsQuery(tsGraph, text));
  const nat = run(() => nativeGraph.query(text));

  console.log(`${name.padEnd(24)} ts: ${ts.padEnd(44)} native: ${nat}`);
}
