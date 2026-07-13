import { traversal, V, has, as_, addE, out, count, values, toArray } from '@lenke/gremlin';

import { createTestTinkerGraph } from './util.ts';

// Doc example form: mid-traversal V with id
try {
  const g = createTestTinkerGraph();
  toArray(traversal(V('1'), as_('a'), V('2'), addE('KNOWS').from('a')), g);
  console.log(
    'DOC-FORM V(1)...V(2).from(a): OK, marko out KNOWS =',
    toArray(traversal(V('1'), out('KNOWS'), count()), g),
  );
} catch (e: any) {
  console.log('DOC-FORM threw:', e.message);
}

// to(sub-traversal) form
try {
  const g = createTestTinkerGraph();
  toArray(
    traversal(V(), has('name', 'marko'), addE('KNOWS').to(traversal(V(), has('name', 'peter')))),
    g,
  );
  console.log(
    'to(subtraversal): OK, marko out KNOWS =',
    toArray(traversal(V('1'), out('KNOWS'), count()), g),
  );
} catch (e: any) {
  console.log('to(subtraversal) threw:', e.message);
}

// from(sub-traversal).to(sub-traversal)
try {
  const g = createTestTinkerGraph();
  toArray(
    traversal(
      addE('KNOWS')
        .from(traversal(V(), has('name', 'marko')))
        .to(traversal(V(), has('name', 'peter'))),
    ),
    g,
  );
  console.log(
    'from/to subtraversal: OK, marko out KNOWS =',
    toArray(traversal(V('1'), out('KNOWS'), count()), g),
  );
} catch (e: any) {
  console.log('from/to subtraversal threw:', e.message);
}
