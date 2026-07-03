import { describe, expect, test } from 'bun:test';

import type { Vertex } from '@lenke/core';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import {
  T,
  V,
  as_,
  dedupe,
  hasLabel,
  in_,
  inV,
  inject,
  out,
  outE,
  select,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP dedupe tests', () => {
    test('it deduplicates strings', () => {
      const all = arr(run(traversal(V(), values('lang')), tinkerGraph));
      expect(all).toEqual(['java', 'java']);

      const deduped = arr(run(traversal(V(), values('lang'), dedupe()), tinkerGraph));
      expect(deduped).toEqual(['java']);
    });

    // doc: g.V().as('a').out('CREATED').as('b').in('CREATED').as('c')
    //        .select('a','b','c').dedup('a','b')
    // dedupe by the (a, b) tuple per traverser.
    test('dedupe(a, b) keeps first occurrence per (a, b) tuple', () => {
      const get = (id: string) => tinkerGraph.getVertexById(id) as Vertex;
      const r = arr(
        run(
          traversal(
            V(),
            as_('a'),
            out('CREATED'),
            as_('b'),
            in_('CREATED'),
            as_('c'),
            select('a', 'b', 'c'),
            dedupe('a', 'b'),
          ),
          tinkerGraph,
        ),
      );
      expect(r).toEqual([
        { a: get('1'), b: get('3'), c: get('1') },
        { a: get('4'), b: get('5'), c: get('4') },
        { a: get('4'), b: get('3'), c: get('1') },
        { a: get('6'), b: get('3'), c: get('1') },
      ]);
    });

    // Single-label dedupe — dedupes by the value tagged at `a`.
    test('dedupe(a) dedupes by single tagged label', () => {
      const get = (id: string) => tinkerGraph.getVertexById(id) as Vertex;
      const r = arr(
        run(
          traversal(
            V(),
            as_('a'),
            out('CREATED'),
            as_('b'),
            in_('CREATED'),
            as_('c'),
            select('a', 'b', 'c'),
            dedupe('a'),
          ),
          tinkerGraph,
        ),
      );
      // 3 distinct `a` values across the 10-row shape: v[1], v[4], v[6].
      expect(r).toEqual([
        { a: get('1'), b: get('3'), c: get('1') },
        { a: get('4'), b: get('5'), c: get('4') },
        { a: get('6'), b: get('3'), c: get('1') },
      ]);
    });

    test('select with as_ a/b/c emits the cartesian shape', () => {
      const get = (id: string) => tinkerGraph.getVertexById(id) as Vertex;
      const r1 = arr(
        run(
          traversal(
            V(),
            as_('a'),
            out('CREATED'),
            as_('b'),
            in_('CREATED'),
            as_('c'),
            select('a', 'b', 'c'),
          ),
          tinkerGraph,
        ),
      );
      expect(r1).toEqual([
        { a: get('1'), b: get('3'), c: get('1') },
        { a: get('1'), b: get('3'), c: get('4') },
        { a: get('1'), b: get('3'), c: get('6') },
        { a: get('4'), b: get('5'), c: get('4') },
        { a: get('4'), b: get('3'), c: get('1') },
        { a: get('4'), b: get('3'), c: get('4') },
        { a: get('4'), b: get('3'), c: get('6') },
        { a: get('6'), b: get('3'), c: get('1') },
        { a: get('6'), b: get('3'), c: get('4') },
        { a: get('6'), b: get('3'), c: get('6') },
      ]);
    });

    // doc: g.V().dedup().by(label).values('name') — marko; lop
    // Keep one vertex per distinct label.
    test('dedupe().by(T.label) keeps one vertex per label', () => {
      const r = arr(run(traversal(V(), dedupe().by(T.label), values('name')), tinkerGraph));
      // First PERSON (marko), first SOFTWARE (lop in fixture order).
      expect(r).toEqual(['marko', 'lop']);
    });

    // doc: g.V().hasLabel("person").out("created").dedup() — v[3]; v[5]
    test('dedup vertices after out(created)', () => {
      const r = arr(
        run(traversal(V(), hasLabel('PERSON'), out('CREATED'), dedupe()), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(r.map((v) => v.id)).toEqual(['3', '5']);
    });

    // doc: g.V().hasLabel("person").outE("created").inV().dedup() — v[3]; v[5]
    test('dedup vertices via outE.inV', () => {
      const r = arr(
        run(traversal(V(), hasLabel('PERSON'), outE('CREATED'), inV(), dedupe()), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(r.map((v) => v.id)).toEqual(['3', '5']);
    });

    // Composite (list) values dedupe structurally, not by reference: two equal
    // lists are distinct JS array refs, but must still collapse — matching the
    // Rust engine and TinkerPop's value-based list equality.
    test('dedupe collapses structurally-equal list values', () => {
      const r = arr(run(traversal(inject([1, 2], [1, 2], [3]), dedupe()), tinkerGraph));
      expect(r).toEqual([[1, 2], [3]]);
    });

    // A recurring *reference* is keyed once then short-circuits via the WeakSet
    // ("slow first, fast after"); a distinct-but-equal reference is caught by
    // the structural key. Both are dropped.
    test('dedupe drops repeated list references and equal-by-value lists', () => {
      const a = [1, 2];
      const r = arr(run(traversal(inject(a, a, [1, 2]), dedupe()), tinkerGraph));
      expect(r).toEqual([[1, 2]]);
    });

    // Lists of graph elements key by element id (via toJSON), so the same vertex
    // in two different lists collapses while different vertices stay distinct.
    test('dedupe keys lists of elements by id', () => {
      const v3 = tinkerGraph.getVertexById('3') as Vertex;
      const v5 = tinkerGraph.getVertexById('5') as Vertex;

      expect(arr(run(traversal(inject([v3], [v3]), dedupe()), tinkerGraph))).toEqual([[v3]]);
      expect(arr(run(traversal(inject([v3], [v5]), dedupe()), tinkerGraph))).toEqual([[v3], [v5]]);
    });
  });
});
