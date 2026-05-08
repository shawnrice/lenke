import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, addE, as_, out, property } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('addE() mutation', () => {
  test('addE(label).to(V("y")) — input is FROM, sub-plan is TO', () => {
    const g = createTestTinkerGraph();
    const before = g.edges.size;
    // marko (1) -[NEMESIS]-> peter (6)
    const r = arr(run(traversal(V('1'), addE('NEMESIS').to(V('6'))), g));
    expect(g.edges.size).toBe(before + 1);
    expect(r).toHaveLength(1);
    const edge = r[0] as { from: { id: string }; to: { id: string }; labels: Set<string> };
    expect(edge.from.id).toBe('1');
    expect(edge.to.id).toBe('6');
    expect(edge.labels.has('NEMESIS')).toBe(true);
  });

  test('addE(label).from(tag).to(V("y")) — tag-form FROM endpoint', () => {
    const g = createTestTinkerGraph();
    // Tag marko, hop to his out-neighbors, then for each one add an edge
    // FROM the tagged marko TO peter. (Demonstrates tag recall driving the
    // FROM endpoint while the current traverser is something else.)
    const before = g.edges.size;
    const r = arr(
      run(
        traversal(
          V('1'),
          as_('start'),
          out('KNOWS'),
          addE('META').from('start').to(V('6')),
        ),
        g,
      ),
    );
    // marko knows vadas + josh → 2 new edges
    expect(r).toHaveLength(2);
    expect(g.edges.size).toBe(before + 2);
    for (const e of r as Array<{ from: { id: string }; to: { id: string } }>) {
      expect(e.from.id).toBe('1');
      expect(e.to.id).toBe('6');
    }
  });

  test('addE() with property() chains property writes onto the new edge', () => {
    const g = createTestTinkerGraph();
    arr(
      run(
        traversal(V('1'), addE('KNOWS').to(V('6')), property('weight', 0.42)),
        g,
      ),
    );
    const created = [...g.edges].find(
      (e) => e.from.id === '1' && e.to.id === '6' && e.labels.has('KNOWS'),
    )!;
    expect(created.properties.weight).toBe(0.42);
  });

  test('addE() throws when neither .from nor .to is specified', () => {
    const g = createTestTinkerGraph();
    expect(() => arr(run(traversal(V('1'), addE('SELF')), g))).toThrow(
      /at least one of \.from\(\) or \.to\(\)/,
    );
  });
});
