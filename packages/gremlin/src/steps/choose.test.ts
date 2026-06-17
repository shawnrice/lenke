import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gt, lte } from '../predicates.js';
import { V, choose, count, has, hasLabel, identity, in_, is, out, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('choose tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().choose(has('name','marko'), values('age'), values('name'))
  // — 29; vadas; lop; josh; ripple; peter
  // v2 fixture order: marko(29), vadas, josh, peter, lop, ripple
  test('choose with then/else', () => {
    const r = arr(
      run(
        traversal(V(), choose(has('name', eq('marko')), values('age'), values('name'))),
        tinkerGraph,
      ),
    );
    expect(r).toEqual([29, 'vadas', 'josh', 'peter', 'lop', 'ripple']);
  });

  // doc: g.V().choose(hasLabel('person'), out('created'), identity()).values('name')
  // Persons project to their out-created targets; non-persons stay.
  // v2 order: marko->lop, vadas->(none -> identity = vadas), josh->ripple,lop, peter->lop, lop, ripple
  test('choose with hasLabel test branches per traverser', () => {
    const r = arr(
      run(
        traversal(V(), choose(hasLabel('PERSON'), out('CREATED'), identity()), values('name')),
        tinkerGraph,
      ),
    );
    // Marko has out-created (lop). Vadas has none — but wait, choose's `test` is
    // a yes/no based on whether test plan emits. hasLabel('PERSON') on vadas
    // emits vadas, so we go to thenPlan: out('CREATED') which yields nothing
    // from vadas. So vadas drops out (then-plan emitted nothing).
    // marko->lop, josh->ripple,lop, peter->lop, lop->lop(identity), ripple->ripple
    expect(r).toEqual(['lop', 'ripple', 'lop', 'lop', 'lop', 'ripple']);
  });

  // doc: g.V().hasLabel('person').choose(values('age').is(lte(30)),__.in(),__.out()).values('name')
  // marko(29) -> in() -> nothing in-edges to marko (no in_)
  // vadas(27) -> in() -> marko
  // josh(32) -> out() -> ripple, lop
  // peter(35) -> out() -> lop
  test('choose branches by predicate on age', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          choose((p) => is(lte(30))(values('age')(p)), in_(), out()),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // marko has no in-vertices, vadas has marko, josh -> ripple,lop, peter -> lop
    expect(r).toEqual(['marko', 'ripple', 'lop', 'lop']);
  });

  // doc: g.V().hasLabel('person').choose(outE('knows').count().is(gt(0)),__.out('knows'),__.identity()).values('name')
  // — vadas; josh; vadas; josh; peter (doc fixture order)
  // v2 order: marko(has out-knows -> vadas, josh), vadas(none -> identity = vadas),
  //   josh(none -> identity = josh), peter(none -> identity = peter)
  test('choose branches on outE count predicate', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          choose((p) => is(gt(0))(count()(outE('KNOWS')(p))), out('KNOWS'), identity()),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['vadas', 'josh', 'vadas', 'josh', 'peter']);
  });

  // doc: g.V().choose(hasLabel('person'), out('created')).values('name')
  // — lop; lop; ripple; lop; ripple; lop
  // Per TinkerPop spec, missing elsePlan = identity: non-matching traversers
  // pass through unchanged.
  // v2 fixture order: marko, vadas, josh, peter, lop, ripple
  //   marko (person) -> out('created') = lop
  //   vadas (person) -> out('created') = (nothing — drops)
  //   josh  (person) -> out('created') = ripple, lop
  //   peter (person) -> out('created') = lop
  //   lop   (software) -> identity = lop
  //   ripple(software) -> identity = ripple
  test('choose without elsePlan: missing else acts as identity (TinkerPop spec)', () => {
    const r = arr(
      run(traversal(V(), choose(hasLabel('PERSON'), out('CREATED')), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['lop', 'ripple', 'lop', 'lop', 'lop', 'ripple']);
  });

  // Sanity: choose(testFails, thenPlan) with no elsePlan yields input unchanged.
  test('choose without elsePlan: test fails -> traverser passes through', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          // Test always fails (no vertex has name 'nonexistent').
          choose(has('name', eq('nonexistent')), out('CREATED')),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // All persons fall through identity, in fixture order: marko, vadas, josh, peter.
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });
});
