import { Graph } from '@lenke/core';

import { formatRows } from './src/table.js';

/*
 * Item 2525: `plain` falls through to `JSON.stringify`, which THROWS on two ordinary shapes — and
 * `value.ts` argues one of them away by REACHABILITY:
 *
 *   > No `bigint` case: the value model is float64-only (bigint is rejected at every write), so a
 *   > cell value is never a bigint.
 *
 * That is a claim about the WRITE path, but `formatRows` takes `Row = Record<string, unknown>` — a
 * public signature that accepts anything a caller holds, whether or not it came from a graph. Item
 * 2516's rule applies: safe BY TYPE beats safe by REACHABILITY, and this is the weaker kind.
 *
 * `JSON.stringify` also throws on a CIRCULAR structure, which is not hypothetical here: a graph
 * element references its adjacency, which references edges, which reference the element.
 *
 * A formatter crashing is worse than a formatter rendering something ugly: it is called to DISPLAY
 * output, often while diagnosing something else, so a throw replaces the information the caller was
 * trying to read.
 *
 * Each row prints what happened. THREW is the finding; a rendered cell is fine whatever it says.
 */
const line = (label: string, got: string): void => {
  const cols = [label.padEnd(38), got];

  console.log(`  ${cols.join(' ')}`);
};

const show = (label: string, rows: Record<string, unknown>[]): void => {
  try {
    const out = formatRows(rows, { color: false });
    const [, , , body] = out.split('\n');

    line(label, `OK    ${JSON.stringify(body ?? out)}`.slice(0, 74));
  } catch (e) {
    line(label, `THREW ${String((e as Error)?.message ?? e).slice(0, 62)}`);
  }
};

console.log('# formatRows on values a caller can actually hold\n');

show('CONTROL: a string', [{ v: 'marko' }]);
show('CONTROL: a number', [{ v: 29 }]);
show('CONTROL: null (first-class)', [{ v: null }]);
show('CONTROL: a plain object', [{ v: { a: 1 } }]);
show('a bigint', [{ v: 10n }]);

const circular: Record<string, unknown> = { name: 'loop' };

circular.self = circular;
show('a circular object', [{ v: circular }]);

/* A REAL graph element — the shape `RETURN n` hands back. */
const g = new Graph();
const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

show('a Vertex with an incident edge', [{ v: a }]);
show('an Edge', [{ v: [...g.edges][0] }]);

/* Other JSON-hostile values a caller may hold. */
show('a function', [{ v: (): number => 1 }]);
show('a Symbol', [{ v: Symbol('s') }]);
show('a Map', [{ v: new Map([['k', 1]]) }]);
show('NaN / Infinity', [{ v: Number.NaN }, { v: Number.POSITIVE_INFINITY }]);

console.log('\n  Read the CONTROL rows first: if any of them throws, the probe is wrong.');
console.log('  THREW on a later row = formatRows crashes on a value its own signature accepts.');
