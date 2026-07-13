// PROBE H: events hand out a LIVE element reference. A journal that stores the
// ref and reads it later (async flush, batched write, end-of-tick) sees
// post-commit state — for a removed vertex, that's EVICTED (empty).
import { Graph } from '@lenke/core';

const g = new Graph();
const v = g.addVertex({ labels: ['Person'], properties: { name: 'Ivy', salary: 100 } });

let capturedRef: any = null;
let readAtEmit = '';
g.on('@graph/VertexRemoved', (e: any) => {
  capturedRef = e.value; // store the ref, as a naive journal would
  readAtEmit = JSON.stringify({
    name: e.value.getProperty('name'),
    salary: e.value.getProperty('salary'),
  });
});

g.removeVertex(v);

// Read the SAME ref after the mutation committed (what an async journal does):
const readAfter = JSON.stringify({
  name: capturedRef.getProperty('name'),
  salary: capturedRef.getProperty('salary'),
  props: capturedRef.properties,
});

console.log('read AT emit  :', readAtEmit);
console.log('read AFTER commit (deferred journal):', readAfter);
console.log(
  '=> a journal that serializes the event ref lazily loses the removed vertex state:',
  readAtEmit !== readAfter ? 'CONFIRMED (data differs)' : 'no difference',
);

// PROBE H2: same for property change — value/previous are primitives (safe),
// but the vertex ref reflects the NEW value if read later.
const g2 = new Graph();
const w = g2.addVertex({ labels: ['Person'], properties: { name: 'Jo', salary: 50 } });
let deferredCheck: any;
g2.on('@graph/VertexPropertyChanged', (e: any) => {
  deferredCheck = () => e.value.vertex.getProperty('salary'); // live ref
  console.log(
    '\nPropertyChanged @emit: vertex.salary =',
    e.value.vertex.getProperty('salary'),
    '(pre-commit, still OLD) previous =',
    e.value.previous,
    'value =',
    e.value.value,
  );
});
w.setProperty('salary', 80);
console.log('PropertyChanged deferred: vertex.salary =', deferredCheck(), '(post-commit, NEW)');
console.log(
  '=> the event value/previous PRIMITIVES are safe; the element REF is time-of-read, not time-of-event',
);
