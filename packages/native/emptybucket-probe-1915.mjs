// Item 1915 — CAN AN ADJACENCY BUCKET BE PRESENT AND EMPTY? `sub-plan-existence.ts` tests
// `set.size > 0` rather than `set !== undefined`, and the comment justifying that cited a test that
// does not actually say so (it reads `?? 0`, which is equally consistent with an ABSENT bucket). So
// this probe asks the structure directly, by every route that can drop a vertex's last edge of a
// label.
import { Graph } from '@lenke/core';

const show = (tag, v, label) => {
  const box = v.adjFrom;
  const set = box?.get(label);

  const boxed = box === undefined ? 'undefined' : 'present';
  const bucket = set === undefined ? 'ABSENT' : `present size=${set.size}`;
  const flag = set !== undefined && set.size === 0 ? '   ⬅ PRESENT AND EMPTY' : '';

  console.log(`${tag.padEnd(26)} box=${boxed} bucket=${bucket}${flag}`);
};

{
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

  show('after addEdge', a, 'E');
  g.removeEdge(e);
  show('after removeEdge', a, 'E');
}

{
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E', 'F'], properties: {} });

  show('two-label addEdge (F)', a, 'F');
  g.removeLabelFromEdge('F', e);
  show('after removeLabelFromEdge', a, 'F');
}

{
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

  // Two edges of the same label, remove one: the bucket must stay with size 1.
  const e2 = g.addEdge({ id: 'e2', from: a, to: b, labels: ['E'], properties: {} });

  g.removeEdge(e);
  show('two E edges, one removed', a, 'E');
  g.removeEdge(e2);
  show('both E edges removed', a, 'E');
}

{
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  // Dropping the far VERTEX takes its edges with it.
  g.removeVertex(b);
  show('far vertex removed', a, 'E');
}
