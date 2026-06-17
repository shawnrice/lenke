import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, in_, optional, out, path, pipe } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('optional tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(2).optional(out('knows')) — v[2] (vadas has no out-knows, so falls back)
  test('optional falls back when sub-traversal is empty', () => {
    const r = arr(run(traversal(V('2'), optional(out('KNOWS'))), tinkerGraph));
    expect((r as Array<{ id: string }>).map((x) => x.id)).toEqual(['2']);
  });

  // doc: g.V(2).optional(__.in('knows')) — v[1]  (vadas has in-knows from marko)
  test('optional yields sub-traversal results when non-empty', () => {
    const r = arr(run(traversal(V('2'), optional(in_('KNOWS'))), tinkerGraph));
    expect((r as Array<{ id: string }>).map((x) => x.id)).toEqual(['1']);
  });

  // doc: g.V().hasLabel('person').optional(out('knows').optional(out('created'))).path()
  // — [v[1],v[2]]; [v[1],v[4],v[5]]; [v[1],v[4],v[3]]; [v[2]]; [v[4]]; [v[6]]
  test('nested optional yields a "lifted" graph through path()', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          optional(pipe(out('KNOWS'), optional(out('CREATED')))),
          path(),
        ),
        tinkerGraph,
      ),
    ) as Array<Array<{ id: string }>>;
    const idPaths = r.map((p) => p.map((v) => v.id));
    // Marko expands two levels: marko->vadas (no created), marko->josh->ripple, marko->josh->lop.
    // Vadas/josh/peter: out(KNOWS) is empty, so optional falls back to identity = self.
    expect(idPaths).toEqual([['1', '2'], ['1', '4', '5'], ['1', '4', '3'], ['2'], ['4'], ['6']]);
  });
});
