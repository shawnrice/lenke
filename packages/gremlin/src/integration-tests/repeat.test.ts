import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, has, hasLabel, out, path, repeat, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Repeat / iterative reachability', () => {
  const g = createTestTinkerGraph();

  // doc: g.V(marko).repeat(out()).times(2).values('name') — ripple; lop
  test('repeat(out()).times(2) from marko reaches grandchildren', () => {
    const r = arr(run(traversal(V('1'), repeat(out()).times(2), values('name')), g));
    expect((r as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  // doc: g.V(1).repeat(out()).until(hasLabel('software')).path().by('name')
  test('repeat(out()).until(hasLabel(SOFTWARE)) yields software-terminal paths', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).until(hasLabel('SOFTWARE')), path().by('name')), g),
    );
    // Three paths: marko->lop, marko->josh->ripple, marko->josh->lop.
    const sorted = (r as string[][]).map((p) => p.join('|')).sort();
    expect(sorted).toEqual(['marko|josh|lop', 'marko|josh|ripple', 'marko|lop']);
  });

  // Reachability: post-form emit() yields each body output (level 1, level 2).
  // To include the start vertex (level 0), use .emitBefore().
  test('repeat(out()).times(2).emit() emits each body output', () => {
    const r = arr(run(traversal(V('1'), repeat(out()).times(2).emit(), values('name')), g));
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  });

  // doc: g.V(1).repeat(out()).times(2).emit(has('lang')).path().by('name')
  test('emit only software (has lang)', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          repeat(out())
            .times(2)
            .emit(has('lang', eq('java'))),
          values('name'),
        ),
        g,
      ),
    );
    // emit when frontier vertex has lang=java; happens at lop (level 1) and ripple/lop (level 2).
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  // doc: g.V(1).repeat(out()).until(outE().count().is(0)).path().by('name')
  // We approximate as until(hasLabel(SOFTWARE)) — software has no out-edges.
  test('terminate at sink (software) via until(hasLabel)', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).until(hasLabel('SOFTWARE')), values('name')), g),
    );
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  // Reachability from marko bounded to 1 hop.
  test('repeat(out()).times(1) is the same as out() from marko', () => {
    const r = arr(run(traversal(V('1'), repeat(out()).times(1), values('name')), g));
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'vadas']);
  });
});
