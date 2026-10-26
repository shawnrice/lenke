// `dedup()` over TEMPORAL values — item 857's raw-key arm.
//
// A `LocalDate` used to take the COMPOSITE dedup path: a `WeakSet` insert per row (to
// short-circuit a repeated reference, which never hits because every vertex carries its own
// instance), a `tupleKey` string build, and a string-`Set` probe. Measured at 200,000 vertices,
// `values('hired').dedup()` cost 107.46 ms against the GQL spelling's 4.6 in the same engine;
// keying a finite date on its epoch day took it to 14.01 (7.7x), level with the `num` and `str`
// spellings whose remaining gap is the traversal stream and not the key.
//
// THESE TESTS EXIST BECAUSE THREE MUTANTS SURVIVED ALL 809 TESTS IN THIS PACKAGE: a constant date
// key, keying into the shared primitive `Set` (where `LocalDate(5)` collides with the number 5),
// and dropping the finiteness guard (which changes how `NaN`/`Infinity` dates group). Nothing
// covered `values(<date>).dedup()` at all.
import { describe, expect, test } from 'bun:test';

import { Graph, LocalDate } from '@lenke/core';

import type { Plan } from './ast.js';
import { run } from './executor.js';
import { V, dedupe, inject, values } from './steps.js';
import { traversal } from './traversal.js';

const g = new Graph();
const arr = (plan: Plan): unknown[] => [...run(plan, g)];

describe('dedup() over temporal values (item 857)', () => {
  test('equal dates collapse and distinct ones do not', () => {
    // `inject` is a literal source, so these are the exact values the dedup sees — no graph
    // read, and no question about which property path produced them.
    const out = arr(
      traversal(
        inject(new LocalDate(19_724), new LocalDate(19_725), new LocalDate(19_724)),
        dedupe(),
      ),
    );

    expect(out.length).toBe(2);
    expect((out as LocalDate[]).map((d) => d.days).sort((a, b) => a - b)).toEqual([19_724, 19_725]);
  });

  test('a date does NOT collide with the raw number its days equals', () => {
    // The arm keys on `days` in its OWN `Set`; keying into the shared primitive one would merge
    // these two into a single traverser, and nothing else in this package would notice.
    expect(arr(traversal(inject(new LocalDate(5), 5), dedupe())).length).toBe(2);
    expect(arr(traversal(inject(5, new LocalDate(5)), dedupe())).length).toBe(2);
  });

  test('a non-finite date keeps the composite-path grouping', () => {
    // `tupleKey` renders a non-finite field the way `JSON.stringify` does, so these two are ONE
    // key there and would be two under a raw `days`. Item 850 pinned that collapse in the GQL
    // executor rather than "improving" it inside a speedup; the finiteness guard here keeps the
    // two engines agreeing.
    expect(
      arr(
        traversal(
          inject(new LocalDate(Number.NaN), new LocalDate(Number.POSITIVE_INFINITY)),
          dedupe(),
        ),
      ).length,
    ).toBe(1);
    // …and a non-finite date is still distinct from a finite one.
    expect(
      arr(traversal(inject(new LocalDate(Number.NaN), new LocalDate(5)), dedupe())).length,
    ).toBe(2);
  });

  test('over a graph property, which is the shape that was 23.5x', () => {
    const gg = new Graph();

    gg.addVertex({ id: 'a', labels: ['P'], properties: { hired: new LocalDate(19_724) } });
    gg.addVertex({ id: 'b', labels: ['P'], properties: { hired: new LocalDate(19_725) } });
    gg.addVertex({ id: 'c', labels: ['P'], properties: { hired: new LocalDate(19_724) } });
    // No `hired` at all: TinkerPop's `values(k)` drops the element, so it contributes nothing.
    gg.addVertex({ id: 'd', labels: ['P'], properties: { other: 1 } });

    const out = [...run(traversal(V(), values('hired'), dedupe()), gg)];

    expect(out.length).toBe(2);
    expect((out as LocalDate[]).map((d) => d.days).sort((a, b) => a - b)).toEqual([19_724, 19_725]);
  });
});
