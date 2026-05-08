import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { bothE, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('bothE tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Order: out edges first (CREATED → 10:josh→ripple, 11:josh→lop), then in
  // edges (KNOWS → 8:marko→josh).
  test('toy test', () => {
    const result = arr(run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'BLAH')), tinkerGraph));
    expect(result).toHaveLength(3);

    const e0 = result[0] as any;
    expect(e0.to.properties.name).toBe('ripple');
    expect(e0.labels.has('CREATED')).toBe(true);

    const e1 = result[1] as any;
    expect(e1.to.properties.name).toBe('lop');
    expect(e1.labels.has('CREATED')).toBe(true);

    const e2 = result[2] as any;
    expect(e2.from.properties.name).toBe('marko');
    expect(e2.labels.has('KNOWS')).toBe(true);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), bothE('KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.to.properties.name)).toEqual(['vadas', 'josh']);
  });

  test('getting all the labels is like asking for none of the labels', () => {
    // V('4') bothE() with no labels: out (10 -> ripple, 11 -> lop), then in (8: marko->josh, to=josh)
    const result = arr(run(traversal(V('4'), bothE()), tinkerGraph));
    expect(result.map((x: any) => x.to.properties.name)).toEqual(['ripple', 'lop', 'josh']);
  });

  // doc: g.V(4).bothE('knows','created','blah') → e[10], e[11], e[8]
  test('bothE(knows,created,blah) on v[4] yields e[10], e[11], e[8]', () => {
    const result = arr(
      run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'blah')), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(result.map((e) => e.id)).toEqual(['10', '11', '8']);
  });

  // doc: g.V(1).bothE() — e[9][1-created->3]; e[7][1-knows->2]; e[8][1-knows->4]
  // v2 fixture inserts KNOWS first (7,8) then CREATED (9), so out edges from
  // marko are 7,8,9. bothE() = out then in. marko has no incoming edges, so
  // we just see 7,8,9.
  test('bothE on v[1]', () => {
    const result = arr(run(traversal(V('1'), bothE()), tinkerGraph)) as Array<{ id: string }>;
    expect(result.map((e) => e.id)).toEqual(['7', '8', '9']);
  });
});
