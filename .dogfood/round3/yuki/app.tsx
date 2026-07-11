// IMPORTANT: this side-effect import must come FIRST — it registers a happy-dom
// DOM onto globalThis before @testing-library/react / react-dom evaluate.
import './happydom.js';

import { Graph } from '@lenke/core';
import { GraphProvider, useGraphSelector, useGraphTraversal, useGraphSubscription } from '@lenke/react';
import { act, render } from '@testing-library/react';
import * as React from 'react';

import { addNode, addChild, addLink, subtreeTitles, ancestorTitles, depthOf, CHILD, LINK } from './mindmap.js';
import { History } from './history.js';
import { traversal, V, out, repeat, dedupe, values, type Plan } from '@lenke/gremlin';

const planSubtree = (rootId: string): Plan =>
  traversal(V(rootId), repeat(out(CHILD)).emit(), dedupe(), values('title'));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Assertion + logging helpers
// ---------------------------------------------------------------------------
let passes = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    throw new Error(`assertion failed: ${label}`);
  }
}

// The graph's change notifications are deferred (queueMicrotask + setTimeout),
// so flush real timers inside act() to let subscribers/hooks catch up.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 25)); });

// ---------------------------------------------------------------------------
// React UI — the three Graph-connector hooks
// ---------------------------------------------------------------------------

// Inspector: live-updates as the selected node's title/kind change. `deps`
// scopes invalidation to just those property keys.
let inspectorRenders = 0;
function Inspector({ id }: { id: string }): React.JSX.Element {
  inspectorRenders++;
  const title = useGraphSelector(
    (g) => g.getVertexById(id)?.getProperty<string>('title') ?? '(gone)',
    Object.is,
    ['title'],
  );
  const kind = useGraphSelector(
    (g) => g.getVertexById(id)?.getProperty<string>('kind') ?? '',
    Object.is,
    ['kind'],
  );
  return <div data-testid="inspector">{`${title} [${kind}]`}</div>;
}

// Subtree panel: a live Gremlin traversal (descendants of `rootId`).
function SubtreePanel({ rootId }: { rootId: string }): React.JSX.Element {
  // GremlinBound closed over the latest snapshot.
  const titles = useGraphTraversal((g) => g.toArray(planSubtree(rootId)).map(String));
  return <div data-testid="subtree">{titles.join(',')}</div>;
}

// A side-effect subscription: bumps a counter once per mutation.
let sideEffectHits = 0;
function MutationCounter(): React.JSX.Element {
  useGraphSubscription(() => {
    sideEffectHits++;
  });
  return <div data-testid="counter" />;
}

function App({ selectedId, rootId }: { selectedId: string; rootId: string }): React.JSX.Element {
  return (
    <>
      <Inspector id={selectedId} />
      <SubtreePanel rootId={rootId} />
      <MutationCounter />
    </>
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Yuki mind-map editor: @lenke/core + @lenke/react + @lenke/gremlin ===\n');

  // --- Build the initial map (outside act() => not undoable) ---------------
  const graph = new Graph();
  const root = addNode(graph, { title: 'Roadmap', kind: 'root' }, 'root');
  const a = addNode(graph, { title: 'Design', kind: 'topic' }, 'a');
  const b = addNode(graph, { title: 'Build', kind: 'topic' }, 'b');
  const a1 = addNode(graph, { title: 'Wireframes', kind: 'task' }, 'a1');
  const a2 = addNode(graph, { title: 'Palette', kind: 'task' }, 'a2');
  addChild(graph, root, a);
  addChild(graph, root, b);
  addChild(graph, a, a1);
  addChild(graph, a, a2);
  addLink(graph, a2, b, 'informs'); // cross-link

  const history = new History(graph);

  console.log('[1] Gremlin layout traversals');
  console.log('  subtree(root)   =', subtreeTitles(graph, 'root'));
  console.log('  ancestors(a2)   =', ancestorTitles(graph, 'a2'));
  console.log('  depth(a2)       =', depthOf(graph, 'a2'));
  check('subtree(root) has 4 descendants', subtreeTitles(graph, 'root').length === 4);
  check('ancestors(a2) = [Design, Roadmap]', ancestorTitles(graph, 'a2').join(',') === 'Design,Roadmap');
  check('depth(a2) === 2', depthOf(graph, 'a2') === 2);

  // --- Render the React tree ----------------------------------------------
  console.log('\n[2] React hooks: live inspector + traversal + subscription');
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <GraphProvider graph={graph}>
        <App selectedId="a2" rootId="root" />
      </GraphProvider>,
    );
  });
  const inspector = () => view.getByTestId('inspector').textContent;
  const subtree = () => view.getByTestId('subtree').textContent;

  check('inspector initial', inspector() === 'Palette [task]', inspector()!);
  check('subtree panel initial', subtree() === 'Design,Build,Wireframes,Palette', subtree()!);
  const rendersBefore = inspectorRenders;

  // --- Live selector re-render on a mutation (through the undo bracket) -----
  await act(async () => {
    history.act('rename Palette', () => a2.setProperty('title', 'Color palette'));
  });
  await flush();
  check('inspector re-rendered on setProperty', inspector() === 'Color palette [task]', inspector()!);
  check('inspector actually re-rendered (render count grew)', inspectorRenders > rendersBefore);

  // --- Undo via events: selector snaps back --------------------------------
  console.log('\n[3] Undo/redo driven purely by graph events');
  console.log('  undo stack:', history.undoLabels);
  await act(async () => { history.undo(); });
  await flush();
  check('undo restored title', a2.getProperty<string>('title') === 'Palette');
  check('inspector re-rendered after undo', inspector() === 'Palette [task]', inspector()!);

  await act(async () => { history.redo(); });
  await flush();
  check('redo re-applied title', a2.getProperty<string>('title') === 'Color palette');
  check('inspector reflects redo', inspector() === 'Color palette [task]', inspector()!);
  await act(async () => { history.undo(); }); // back to 'Palette' for later checks
  await flush();

  // --- Live traversal re-render: add a child under root --------------------
  const sub = addNode(graph, { title: 'Ship', kind: 'topic' }, 'c');
  await act(async () => {
    history.act('add Ship under root', () => addChild(graph, root, sub));
  });
  await flush();
  check('subtree panel grew after addChild', subtree()!.split(',').includes('Ship'), subtree()!);
  await act(async () => { history.undo(); });
  await flush();
  check('subtree panel shrank after undo', !subtree()!.split(',').includes('Ship'), subtree()!);
  // remove the now-orphaned 'Ship' node so later counts are clean
  graph.removeVertex('c');

  // --- The hard case: removeVertex cascade, undone atomically --------------
  console.log('\n[4] Cascading removeVertex, reversed from one event group');
  const edgesBefore = graph.edgeCount;
  const vertsBefore = graph.vertexCount;
  const incidentToA = [...edgeIds(graph, 'a')];
  console.log('  removing "Design" (a): incident edges =', incidentToA.length);
  await act(async () => {
    history.act('delete Design', () => graph.removeVertex('a'));
  });
  await flush();
  check('vertex gone after remove', graph.getVertexById('a') === null);
  check('cascade removed incident edges', graph.edgeCount < edgesBefore);
  check('inspector for child a2 shows ancestor loss', depthOf(graph, 'a2') === 0, `depth=${depthOf(graph, 'a2')}`);

  await act(async () => { history.undo(); });
  await flush();
  check('undo restored the vertex', graph.getVertexById('a') !== null);
  check('undo restored vertex count', graph.vertexCount === vertsBefore, `${graph.vertexCount} vs ${vertsBefore}`);
  check('undo restored edge count (tree + cross-link)', graph.edgeCount === edgesBefore, `${graph.edgeCount} vs ${edgesBefore}`);
  check('ancestor chain rebuilt', ancestorTitles(graph, 'a2').join(',') === 'Design,Roadmap', ancestorTitles(graph, 'a2').join(','));
  check('cross-link LINK restored', graph.getEdgesByLabel(LINK).size === 1);

  // --- Subscription side-effect fired -------------------------------------
  console.log('\n[5] useGraphSubscription side-effect');
  check('subscription observed mutations', sideEffectHits > 0, `hits=${sideEffectHits}`);

  view.unmount();
  history.dispose();
  console.log(`\n=== ALL ${passes} CHECKS PASSED ===`);
}

function edgeIds(graph: Graph, vertexId: string): Set<string> {
  const ids = new Set<string>();
  for (const m of [graph.edgesFromByLabel.get(vertexId), graph.edgesToByLabel.get(vertexId)]) {
    for (const bucket of m?.values() ?? []) for (const e of bucket) ids.add(e.id);
  }
  return ids;
}

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err);
  process.exit(1);
});
