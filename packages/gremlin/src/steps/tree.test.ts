import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, has, out, tree, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('tree tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().has('name','josh').out('created').values('name').tree()
  // — [v[4]:[v[3]:[lop:[]],v[5]:[ripple:[]]]]
  test('tree builds a nested map of paths from josh to software names', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', { op: 'eq', value: 'josh' }),
          out('CREATED'),
          values('name'),
          tree(),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toHaveLength(1);
    const root = r[0] as Map<unknown, unknown>;
    // Root has one entry: josh.
    expect(root.size).toBe(1);
    const joshKey = [...root.keys()][0] as { properties: { name: string } };
    expect(joshKey.properties.name).toBe('josh');
    // Josh -> two software vertices.
    const joshChildren = root.get(joshKey) as Map<unknown, unknown>;
    expect(joshChildren.size).toBe(2);
    // Each software vertex maps to a child with one entry (its name).
    const softwareNames: string[] = [];
    for (const [_v, sub] of joshChildren) {
      const child = sub as Map<unknown, unknown>;
      expect(child.size).toBe(1);
      softwareNames.push([...child.keys()][0] as string);
    }
    softwareNames.sort();
    expect(softwareNames).toEqual(['lop', 'ripple']);
  });

  // tree built across all persons->created software.
  test('tree of person->created->software covers all creators', () => {
    const r = arr(
      run(
        traversal(V(), has('name', { op: 'eq', value: 'marko' }), out('CREATED'), tree()),
        tinkerGraph,
      ),
    );
    expect(r).toHaveLength(1);
    const root = r[0] as Map<unknown, unknown>;
    expect(root.size).toBe(1); // one root: marko
    const markoChildren = [...root.values()][0] as Map<unknown, unknown>;
    expect(markoChildren.size).toBe(1); // marko -> lop
  });

  // doc: g.V().out().out().tree().by('name')
  // — keys are name strings rather than vertex references; round-robin if
  // multiple by()s.
  test("tree().by('name') keys nodes by their name property", () => {
    const r = arr(run(traversal(V('1'), out(), out(), tree().by('name')), tinkerGraph));
    expect(r).toHaveLength(1);
    const root = r[0] as Map<unknown, unknown>;
    // marko at root.
    expect([...root.keys()]).toEqual(['marko']);
    const markoChildren = root.get('marko') as Map<unknown, unknown>;
    // marko's out: vadas, josh, lop. Only josh has further out (ripple, lop).
    // Path elements are [v1, vN, vM] for tree built from 2-hop paths.
    // 2-hop paths from marko: marko->josh->ripple, marko->josh->lop.
    expect([...markoChildren.keys()]).toEqual(['josh']);
    const joshChildren = markoChildren.get('josh') as Map<unknown, unknown>;
    expect(new Set(joshChildren.keys())).toEqual(new Set(['ripple', 'lop']));
  });

  test('tree is empty when stream is empty', () => {
    const r = arr(
      run(traversal(V(), has('name', { op: 'eq', value: 'nobody' }), tree()), tinkerGraph),
    );
    expect(r).toHaveLength(1);
    expect((r[0] as Map<unknown, unknown>).size).toBe(0);
  });
});
