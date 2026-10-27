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

import {
  Duration,
  Graph,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
  ZonedTime,
} from '@lenke/core';

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

  // ITEM 1017: the kinds item 857 left on the composite path, which cost `datetime` 77.2 ms,
  // `localtime` 50.1 and `zoned` 73.8 against a raw-keyed date's 11.8 at 200,000 rows. They key
  // on the fields `@lenke/core`'s `temporalKeyFields` names, in ONE nested container.
  test('every raw-keyable kind collapses equal values and splits distinct ones', () => {
    // Three values per kind, exactly two equal — so a dropped field answers 1 and an over-split
    // answers 3. Both failure directions visible, as for the date case above.
    const pairs: [string, unknown[]][] = [
      ['LocalTime', [new LocalTime(3600, 7), new LocalTime(3600, 8), new LocalTime(3600, 7)]],
      [
        'LocalDateTime',
        [new LocalDateTime(10, 7), new LocalDateTime(10, 8), new LocalDateTime(10, 7)],
      ],
      [
        'ZonedDateTime',
        [
          new ZonedDateTime(10, 7, 60),
          // OFFSET alone: the same instant, rendered differently, so two values.
          new ZonedDateTime(10, 7, 120),
          new ZonedDateTime(10, 7, 60),
        ],
      ],
      [
        'ZonedTime',
        [new ZonedTime(10, 7, 60), new ZonedTime(10, 7, 120), new ZonedTime(10, 7, 60)],
      ],
      [
        // DECLINED — `Duration` keeps the composite path, and must still dedup correctly there.
        'Duration',
        [new Duration(0, 0, 0, 1), new Duration(0, 1, 0, 0), new Duration(0, 0, 0, 1)],
      ],
    ];

    for (const [name, vals] of pairs) {
      expect(arr(traversal(inject(...vals), dedupe())).length, name).toBe(2);
    }
  });

  test('two kinds with identical fields do not share a key', () => {
    // `LocalTime(5, 7)` and `LocalDateTime(5, 7)` carry the same two fields and are different
    // values of different types. One container holds every kind, so the separation comes from the
    // KIND RANK that `temporalKeyFields` puts in front of the fields — without it these collapse
    // into one group. The GQL twin hit this collision at item 1014 and solved it with a container
    // per kind; this is the same separation in one container.
    expect(
      arr(traversal(inject(new LocalTime(5, 7), new LocalDateTime(5, 7)), dedupe())).length,
    ).toBe(2);
    expect(
      arr(traversal(inject(new ZonedTime(5, 7, 60), new ZonedDateTime(5, 7, 60)), dedupe())).length,
    ).toBe(2);
    // ...and against the kind that keeps its OWN container, plus the raw number its field equals.
    expect(arr(traversal(inject(new LocalDate(5), new LocalTime(5, 0)), dedupe())).length).toBe(2);
    expect(arr(traversal(inject(new LocalTime(5, 0), 5), dedupe())).length).toBe(2);
  });

  test('a non-finite field keeps the composite-path grouping for every kind', () => {
    // The finiteness guard, in the direction that matters: a field the raw key would key on is
    // non-finite, so the value falls back — and the FINITE field still separates the two, which
    // raw keying on `NaN` would not. Same decision item 843 pinned, one kind wider.
    expect(
      arr(traversal(inject(new LocalTime(1, Infinity), new LocalTime(2, Infinity)), dedupe()))
        .length,
    ).toBe(2);
    expect(
      arr(
        traversal(
          inject(new LocalDateTime(1, Number.NaN), new LocalDateTime(2, Number.NaN)),
          dedupe(),
        ),
      ).length,
    ).toBe(2);
    // A NON-FINITE OFFSET GOES THE OTHER WAY, and the number is 1 rather than 2. These two
    // ZonedDateTimes differ in `secs`, but the composite path renders a non-finite offset in a
    // form that swallows the rest, so it has ALWAYS put them in one group — measured, not
    // assumed: this assertion was written expecting 2 and the engine said 1, before and after.
    // The guard sends the value to that path untouched, so the behaviour is preserved rather
    // than chosen here; raw keying would have SPLIT them, which is why the guard is needed in
    // this direction too.
    expect(
      arr(
        traversal(
          inject(new ZonedDateTime(1, 0, Number.NaN), new ZonedDateTime(2, 0, Number.NaN)),
          dedupe(),
        ),
      ).length,
    ).toBe(1);
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
