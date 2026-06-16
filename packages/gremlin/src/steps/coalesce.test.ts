import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, coalesce, hasLabel, inV, label, outE, path, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('coalesce tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().hasLabel('person').coalesce(values('nickname'), values('name'))
  // — okram; vadas; josh; peter (doc fixture has marko's nickname=okram).
  // Our fixture has no nickname, so coalesce always falls back to name.
  test('coalesce falls back to second sub-traversal when first is empty', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), coalesce(values('nickname'), values('name'))),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });

  // legacy: g.V('1').coalesce(outE('CREATED'), outE('KNOWS')).inV().values('name') — lop
  test('coalesce takes first non-empty sub-plan', () => {
    const r = arr(
      run(
        traversal(V('1'), coalesce(outE('CREATED'), outE('KNOWS')), inV(), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['lop']);
  });

  // doc: g.V(1).coalesce(outE('knows'), outE('created')).inV().path().by('name').by(label)
  // — [marko,KNOWS,vadas]; [marko,KNOWS,josh]
  test('coalesce(knows-first) emits the KNOWS edge paths', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          coalesce(outE('KNOWS'), outE('CREATED')),
          inV(),
          path().by('name').by(label()),
        ),
        tinkerGraph,
      ),
    ) as Array<Array<unknown>>;
    expect(r).toEqual([
      ['marko', 'KNOWS', 'vadas'],
      ['marko', 'KNOWS', 'josh'],
    ]);
  });

  // doc: g.V(1).coalesce(outE('created'), outE('knows')).inV().path().by('name').by(label)
  // — [marko,CREATED,lop]
  test('coalesce(created-first) emits only the CREATED path', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          coalesce(outE('CREATED'), outE('KNOWS')),
          inV(),
          path().by('name').by(label()),
        ),
        tinkerGraph,
      ),
    ) as Array<Array<unknown>>;
    expect(r).toEqual([['marko', 'CREATED', 'lop']]);
  });

  // legacy: g.V('1').coalesce(outE('KNOWS'), outE('CREATED')).inV().values('name') — vadas, josh
  test('coalesce takes first non-empty sub-plan (knows first)', () => {
    const r = arr(
      run(
        traversal(V('1'), coalesce(outE('KNOWS'), outE('CREATED')), inV(), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['vadas', 'josh']);
  });
});
