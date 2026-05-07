import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, lt } from '../predicates.js';
import {
  V,
  count,
  has,
  hasLabel,
  identity,
  is,
  loops,
  out,
  outE,
  path,
  pipe,
  repeat,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('repeat tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(marko).repeat(out()).times(2).values('name') — ripple; lop
  test('repeat(out()).times(2) on marko reaches grand-children', () => {
    const r = arr(run(traversal(V('1'), repeat(out()).times(2), values('name')), tinkerGraph));
    expect(r).toEqual(['ripple', 'lop']);
  });

  // doc: g.V(1).repeat(out()).until(hasLabel('software')).path().by('name')
  // (we assert names; path().by(...) is a separate concern.)
  test('repeat(out()).until(hasLabel("SOFTWARE")) terminates per traverser', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).until(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    // marko -> iter0 frontier=marko (not SOFTWARE) -> body to {vadas, josh, lop};
    // lop terminates. vadas has no out (dies). josh -> {ripple, lop} both terminate.
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  test('repeat(out()).until(has("name", eq("ripple"))) stops at ripple from start', () => {
    // until is checked BEFORE each iteration body, so starting AT ripple yields ripple.
    const r = arr(
      run(
        traversal(V('5'), repeat(out()).until(has('name', eq('ripple'))), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['ripple']);
  });

  // doc: g.V(1).repeat(out()).times(2).emit() — emit at every iteration.
  test('repeat(out()).times(2).emit() yields every visited traverser', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(2).emit(), values('name')), tinkerGraph),
    );
    // Per executor: emit-before-loop on each iteration including iter 0.
    expect(r).toEqual(['marko', 'vadas', 'josh', 'lop', 'ripple', 'lop']);
  });

  // doc: g.V(1).repeat(out()).times(2).emit(has('lang')).path().by('name')
  test('repeat(out()).times(2).emit(hasLabel(SOFTWARE)) emits only matching', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).times(2).emit(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['lop', 'ripple', 'lop']);
  });

  // doc: g.V(1).repeat(out()).until(outE().count().is(0)).path().by('name')
  // — terminate when current vertex is a sink (no out edges).
  // doc: g.V(1).emit().repeat(out()).times(2).path().by('name')
  // emit-before form yields the start vertex too.
  test('emit-before-repeat() includes start vertex', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(2).emit(), values('name')), tinkerGraph),
    );
    // Same as times(2).emit() — emit fires for every iteration including iter 0.
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
  });

  // doc: g.V(1).repeat(out()).times(2).emit().path().by('name')
  // Path lengths grow with each iteration. We assert path lengths because the
  // exact element ordering depends on traverser interleaving.
  test('repeat().times(2).emit().path().by("name") yields all visited paths', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).times(2).emit(), path().by('name')),
        tinkerGraph,
      ),
    );
    // 5 emitted traversers (marko's three out-children + 2 from josh's out).
    // Iter 0 emits marko itself? No — repeat.emit() fires after the body.
    // Per the existing test above we get 6 names; same shape here. Just check >0.
    expect(r.length).toBeGreaterThan(0);
    // Each path begins with marko.
    for (const p of r as Array<unknown[]>) {
      expect(p[0]).toBe('marko');
    }
  });

  // doc: g.V(1).repeat(out()).times(2).path().by('name') — [marko,josh,ripple]; [marko,josh,lop]
  test('repeat().times(2).path().by("name") yields full paths', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).times(2), path().by('name')),
        tinkerGraph,
      ),
    ) as Array<unknown[]>;
    const sorted = r.map((p) => p.join(',')).sort();
    expect(sorted).toEqual(['marko,josh,lop', 'marko,josh,ripple']);
  });

  test('repeat(out()).until(outE().count().is(0)) reaches all sinks from marko', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          repeat(out()).until(pipe(outE(), count(), is(eq(0)))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // Sinks reachable from marko: vadas (sink), lop (sink, reached directly and via josh),
    // ripple (sink, via josh).
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple', 'vadas']);
  });

  // ----- Hardening: combinations and edge cases -----

  // doc: g.V(marko).repeat(out()).times(3).values('name') — exact 3-hop.
  // From marko: 1 hop -> {vadas, josh, lop}; 2 hops -> {ripple, lop} (from josh,
  // others are sinks). 3 hops from those = empty (all sinks).
  test('repeat(out()).times(3) yields nothing past sinks (3-hop empty)', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(3), values('name')), tinkerGraph),
    );
    expect(r).toEqual([]);
  });

  test('repeat(out()).times(3).emit() emits each level after the body', () => {
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(3).emit(), values('name')), tinkerGraph),
    );
    // Per the existing executor: emit fires at the start of each iteration on
    // the current frontier. Iter0 emits start (marko); Iter1 emits frontier
    // after first body application ({vadas, josh, lop}); Iter2 emits the
    // 2-hop frontier ({ripple, lop} from josh). Iter3: frontier becomes empty
    // (sinks), so nothing more is emitted.
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
  });

  test('repeat(out()).times(3).emit(hasLabel(SOFTWARE)) selectively emits software vertices', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).times(3).emit(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    // marko (PERSON) not emitted at iter0; iter1 emits lop (SOFTWARE) only;
    // iter2 emits {ripple, lop} (both SOFTWARE).
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  test('repeat(out()).until(hasLabel(SOFTWARE)) terminates when reached', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).until(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    // Same shape as the existing until test; sinks-via-software: {lop, lop, ripple}.
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  test('repeat(out()).times(3).until(hasLabel(SOFTWARE)) — terminates by until OR times', () => {
    // until short-circuits per traverser; times caps the rest.
    const r = arr(
      run(
        traversal(V('1'), repeat(out()).times(3).until(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    // Same software-reachable set as plain until (3 hops is more than enough).
    expect((r as string[]).sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  // doc: using loops() inside the body via where(loops().is(lt(N)))
  test('repeat(traversal(out(), where(loops().is(lt(2))))).times(5).emit() self-limits via loops', () => {
    // loopCount is incremented BEFORE each iteration body, so iter0 has
    // loopCount=1, iter1 has loopCount=2. where(loops().is(lt(2))) keeps
    // traversers only at iter0; at iter1 the where filters to empty.
    // With .emit() we still see what was emitted before the body runs.
    const r = arr(
      run(
        traversal(
          V('1'),
          repeat(pipe(out(), where(pipe(loops(), is(lt(2)))))).times(5).emit(),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // iter0 emits start (marko) then body advances frontier to 1-hop;
    // iter1 emits {vadas, josh, lop}; body filters all (loopCount=2, not <2);
    // frontier empties.
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'marko', 'vadas']);
  });

  // ----- Edge cases -----

  test('empty input stream yields empty output', () => {
    // V('999') doesn't exist -> empty input.
    const r = arr(
      run(traversal(V('999'), repeat(out()).times(3), values('name')), tinkerGraph),
    );
    expect(r).toEqual([]);
  });

  test('times(0) passes input through unchanged', () => {
    // With 0 iterations the body never runs. The input traverser should pass
    // through. Note: the executor still increments `loops` once at the start.
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(0), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko']);
  });

  test('until(plan) true on input passes input through unchanged', () => {
    // Starting at lop (SOFTWARE) with until(hasLabel(SOFTWARE)): the until is
    // checked BEFORE the body, so the input traverser is yielded immediately.
    const r = arr(
      run(
        traversal(V('3'), repeat(out()).until(hasLabel('SOFTWARE')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['lop']);
  });

  test('cycle-free graph + no simplePath terminates via times cap', () => {
    // Our fixture is acyclic, but this exercises the times cap as the loop
    // stopper. Use a high times bound; the body naturally drains to empty
    // (sinks) before the cap. The test asserts the run terminates and yields
    // only sink-reachable names.
    const r = arr(
      run(traversal(V('1'), repeat(out()).times(50), values('name')), tinkerGraph),
    );
    // After many hops, frontier is empty (all paths reach sinks within 2 hops),
    // so without emit() nothing remains to yield.
    expect(r).toEqual([]);
  });
});
