import { Graph } from '@lenke/core';
import { addV, property, run, traversal, V } from '@lenke/gremlin';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';

/*
 * Item 2515: does `addV('')` reach the label validator on BOTH engines?
 *
 * `packages/gremlin/GAPS.md` states the contract and, read closely, names the discrepancy itself:
 *
 *   > A **label / edge type** must be non-empty and free of `::` … Enforced identically in the Rust
 *   > core (`validate_label` / `validate_prop_key`, at codec ingestion + **`addV`/`addE`/`property`**)
 *   > and the TS core (`validateLabel` / `validatePropertyKey`, at
 *   > **`addVertex`/`addEdge`/`addLabelTo*`/`setProperty`**).
 *
 * The Rust list includes `addV`; the TS list does NOT — it names only the core API. So "enforced
 * identically" is a claim this probe can check rather than assume.
 *
 * ORACLE: TinkerPop 3.7.3 raises `IllegalArgumentException("Label can not be empty")` for `addV('')`
 * and creates NO vertex (count stayed 6), and raises the same for `addE('')`. It also raises
 * `"Property key can not be the empty string"` for `property('')`, which BOTH lenke engines match.
 * (TinkerPop accepts `addV('a::b')`; lenke rejects it — a deliberate GraphSON round-trip extension
 * documented in `GAPS.md`, not a divergence to fix.)
 *
 * Every row prints what it did, and the VALID control runs on both engines — a control that fails is
 * an instrument bug, and an earlier attempt at this probe had exactly that (shell quoting mangled
 * the argument so `addV('Q')` threw "expected a string argument").
 */
const line = (label: string, got: string): void => {
  const cols = [label.padEnd(34), got];

  console.log(`  ${cols.join(' ')}`);
};

const tryTs = (label: string, fn: () => unknown): void => {
  try {
    line(label, `OK    ${JSON.stringify(fn()).slice(0, 56)}`);
  } catch (e) {
    line(label, `THREW ${String((e as Error)?.message ?? e).slice(0, 56)}`);
  }
};

console.log('TS engine (packages/gremlin):');

tryTs('addV("") — rows + stored labels', () => {
  const g = new Graph();
  const rows = [...run(traversal(addV('')), g)];
  const labels = [...g.vertices].map((v) => [...v.labels]);

  return { rows: rows.length, vertexCount: g.vertexCount, labels };
});

tryTs('addV("Q") CONTROL', () => {
  const g = new Graph();
  const rows = [...run(traversal(addV('Q')), g)];

  return { rows: rows.length, labels: [...g.vertices].map((v) => [...v.labels]) };
});

tryTs('property("", 1)', () => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: {} });

  return [...run(traversal(V(), property('', 1)), g)].length;
});

tryTs(
  'addVertex({labels:[""]}) core API',
  () => new Graph().addVertex({ id: 'a', labels: [''], properties: {} }).id,
);

if (!nativeReady) {
  console.log('\nnative backend unavailable — the Rust half cannot run here');
} else {
  const backend = nativeBackend();
  const decoder = new TextDecoder();
  const ndjson = '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}';

  const tryNative = (label: string, text: string): void => {
    const handle = backend.graphFromNdjson(new TextEncoder().encode(ndjson));

    try {
      line(label, `OK    ${decoder.decode(backend.gremlinJson(handle, text)).slice(0, 56)}`);
    } catch (e) {
      line(label, `THREW ${String((e as Error)?.message ?? e).slice(0, 56)}`);
    } finally {
      backend.graphFree(handle);
    }
  };

  console.log('\nNative engine (Rust), same shapes through planToGremlin text:');
  tryNative('addV("")', "g.addV('')");
  tryNative('addV("Q") CONTROL', "g.addV('Q')");
  tryNative('property("", 1)', "g.V().property('', 1)");
}

console.log('\n  TinkerPop 3.7.3: addV("") RAISES "Label can not be empty" and creates NO vertex.');
console.log('  A CONTROL that fails is an instrument bug — read the control row first.');
