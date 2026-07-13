import { Graph } from '@lenke/core';

const hr = (s: string) => console.log(`\n=== ${s} ===`);
const line = (s: string) => console.log('  ' + s);

// PROBE I: truncate() — is a whole-graph wipe visible to listeners?
hr('PROBE I: truncate() observability');
{
  const g = new Graph();
  const a = g.addVertex({ labels: ['Employee'], properties: { name: 'A' } });
  const b = g.addVertex({ labels: ['Employee'], properties: { name: 'B' } });
  g.addEdge({ from: a, to: b, labels: ['REPORTS_TO'], properties: {} });
  let count = 0;
  const types = ['@graph/VertexRemoved', '@graph/EdgeRemoved'];
  const offs = types.map((t) => g.on(t as any, () => count++));
  const before = [...g.vertices].length;
  g.truncate();
  offs.forEach((o) => o());
  line(`vertices ${before} -> ${[...g.vertices].length}; removal events emitted: ${count}`);
  line(
    count === 0
      ? '=> A FULL WIPE IS INVISIBLE to the audit log (no events).'
      : '=> wipe emitted events.',
  );
}

// PROBE J: disableEvents() blind window — writes during it are unjournaled.
hr('PROBE J: disableEvents() blind window');
{
  const g = new Graph();
  let count = 0;
  g.on('@graph/VertexAdded', () => count++);
  g.disableEvents();
  g.addVertex({ labels: ['Employee'], properties: { name: 'ghost1' } });
  g.addVertex({ labels: ['Employee'], properties: { name: 'ghost2' } });
  g.enableEvents();
  g.addVertex({ labels: ['Employee'], properties: { name: 'seen' } });
  line(
    `3 adds, 2 during disableEvents; events seen: ${count} (ghosts unjournaled: ${3 - 1 - count === 0 ? 'yes, 2 silent' : '?'})`,
  );
}

// PROBE K: EdgeRemoved endpoints readable at emit (needed to reconstruct a
// removed relationship)?
hr('PROBE K: EdgeRemoved endpoints at emit');
{
  const g = new Graph();
  const a = g.addVertex({ labels: ['Employee'], properties: { name: 'Mgr' } });
  const b = g.addVertex({ labels: ['Employee'], properties: { name: 'Report' } });
  const edge = g.addEdge({ from: a, to: b, labels: ['REPORTS_TO'], properties: { since: 2020 } });
  let atEmit = '',
    afterCommit = '';
  g.on('@graph/EdgeRemoved', (e: any) => {
    try {
      atEmit = `${e.value.from.getProperty('name')} -> ${e.value.to.getProperty('name')}`;
    } catch (err) {
      atEmit = 'THREW: ' + (err as Error).message;
    }
  });
  let capturedEdge: any;
  g.on('@graph/EdgeRemoved', (e: any) => {
    capturedEdge = e.value;
  });
  g.removeEdge(edge);
  try {
    afterCommit = `${capturedEdge.from.getProperty('name')} -> ${capturedEdge.to.getProperty('name')}`;
  } catch (err) {
    afterCommit = 'THREW: ' + (err as Error).message;
  }
  line(`endpoints at emit:         ${atEmit}`);
  line(`endpoints after commit:    ${afterCommit}`);
}

// PROBE L: no-op writes — does setProperty to the SAME value still emit?
hr('PROBE L: no-op write noise');
{
  const g = new Graph();
  const v = g.addVertex({ labels: ['Employee'], properties: { salary: 100 } });
  let count = 0;
  g.on('@graph/VertexPropertyChanged', () => count++);
  v.setProperty('salary', 100); // same value
  v.setProperty('salary', 100); // same value again
  line(
    `2 same-value writes -> ${count} PropertyChanged events (${count > 0 ? 'noise: no-ops are journaled as changes' : 'de-duped'})`,
  );
}

// PROBE M: can direct .properties mutation bypass the journal?
hr('PROBE M: direct .properties bypass');
{
  const g = new Graph();
  const v = g.addVertex({ labels: ['Employee'], properties: { salary: 100 } });
  try {
    (v.properties as any).salary = 999;
    line(`direct write succeeded, salary=${v.getProperty('salary')} (BYPASS possible)`);
  } catch (e) {
    line(`direct write threw: ${(e as Error).constructor.name} (bypass blocked — good)`);
  }
}
