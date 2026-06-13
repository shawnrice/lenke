import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';
import { deserializeAsync, serializeAsync } from './index.js';
import { graphContentEqual, randomLpgGraph } from './testkit.js';

/** A graph big enough that (de)serialization takes well over a timer tick. */
const bigGraph = (): Graph => {
  const g = new Graph();
  g.disableEvents();
  const nodes = [];
  for (let i = 0; i < 30000; i += 1) {
    nodes.push(g.addVertex({ id: `n${i}`, labels: ['N'], properties: { a: i, s: `s${i}` } }));
  }
  for (let i = 0; i < 30000; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: nodes[i]!,
      to: nodes[(i + 1) % 30000]!,
      labels: ['R'],
      properties: { w: i },
    });
  }
  g.enableEvents();
  return g;
};

/** Run `op`, counting how many times a 1ms timer fires while it's in flight. */
const ticksDuring = async (op: () => Promise<unknown>): Promise<number> => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 1);
  try {
    await op();
  } finally {
    clearInterval(timer);
  }
  return ticks;
};

describe('serializeAsync / deserializeAsync', () => {
  test('round-trips through ndjson (full fidelity)', async () => {
    const g = randomLpgGraph(3);
    const text = await serializeAsync(g, 'ndjson');
    expect(graphContentEqual(await deserializeAsync(text, 'ndjson', new Graph()), g)).toBe(true);
  });

  test('serializeAsync lets the event loop run (timers fire mid-flight)', async () => {
    const g = bigGraph();
    const ticks = await ticksDuring(() => serializeAsync(g, 'ndjson'));
    expect(ticks).toBeGreaterThan(0);
  });

  test('deserializeAsync lets the event loop run', async () => {
    const text = await serializeAsync(bigGraph(), 'ndjson');
    const ticks = await ticksDuring(() => deserializeAsync(text, 'ndjson', new Graph()));
    expect(ticks).toBeGreaterThan(0);
  });

  test('works across the streaming formats and JSON fallback', async () => {
    const g = randomLpgGraph(8);
    // line-oriented formats run non-blocking; just verify they round-trip nodes.
    for (const format of ['pg-text', 'ndjson', 'csv'] as const) {
      const back = await deserializeAsync(await serializeAsync(g, format), format, new Graph());
      expect([...back.vertices].length).toBe([...g.vertices].length);
    }
    // single-document JSON falls back (yields once); still correct.
    const json = await serializeAsync(g, 'pg-json');
    expect(graphContentEqual(await deserializeAsync(json, 'pg-json', new Graph()), g)).toBe(true);
  });
});
