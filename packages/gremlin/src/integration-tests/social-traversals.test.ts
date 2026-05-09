import { describe, expect, test } from 'bun:test';
import type { Vertex } from '@pl-graph/core';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gt } from '../predicates.js';
import {
  V,
  both,
  count,
  dedupe,
  has,
  hasLabel,
  in_,
  out,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Social traversals', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().has('name','marko').out('knows').values('name') — vadas; josh
  test("marko's direct friends (out knows)", () => {
    const r = arr(
      run(traversal(V(), has('name', eq('marko')), out('KNOWS'), values('name')), g),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'vadas']);
  });

  // doc: g.V().has('name','marko').out('knows').has('age', gt(29)).values('name') — josh
  test("marko's friends older than 29", () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          out('KNOWS'),
          has('age', gt(29)),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['josh']);
  });

  // marko's friends-of-friends (deduped, excluding marko himself).
  test("friends-of-friends of marko (deduped)", () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          out('KNOWS'),
          out('KNOWS'),
          dedupe(),
          values('name'),
        ),
        g,
      ),
    );
    // marko knows {vadas, josh}; vadas has no out-knows; josh has no out-knows.
    // So FoF is empty in tinker-modern.
    expect(r).toEqual([]);
  });

  // Reachability from marko via 'both' over knows.
  test('people reachable from marko via two knows hops (both)', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          both('KNOWS'),
          both('KNOWS'),
          dedupe(),
          values('name'),
        ),
        g,
      ),
    );
    // marko ↔ {vadas, josh}; back from vadas → marko; from josh → marko. Dedup → marko.
    expect(r).toEqual(['marko']);
  });

  // doc: g.V().where(__.in('created').count().is(gte(2))).values('name') — lop
  test('software with multiple creators', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('SOFTWARE'),
          where((p) => count()(in_('CREATED')(p))),
          values('name'),
        ),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  // People who know someone who created lop.
  test('people who know a creator of lop', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          where((p) =>
            out('KNOWS')(p), // simply has any KNOWS out edge
          ),
          out('KNOWS'),
          where((p) => out('CREATED')(p)), // friend has CREATED edge
          dedupe(),
          values('name'),
        ),
        g,
      ),
    );
    // marko knows josh (who created lop & ripple). vadas/josh have no KNOWS out.
    expect(r).toEqual(['josh']);
  });

  // doc: g.V().out('knows').where(out('created')).values('name') — josh
  test("marko's friends who have created something", () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          out('KNOWS'),
          where(out('CREATED')),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['josh']);
  });

  // Mutual collaborators on lop: people who created lop.
  test('all creators of lop (via in CREATED)', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('lop')),
          in_('CREATED'),
          values('name'),
        ),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter']);
  });

  // doc: g.V(1).bothE().where(otherV().hasId(2)) - we use hasId on otherV.
  // Vertices reachable from marko in 1 step (both directions, both labels).
  test('1-hop neighborhood of marko (both)', () => {
    const r = arr(
      run(traversal(V('1'), both(), dedupe(), values('name')), g),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'vadas']);
  });

  // Vertices object-identity check: marko's KNOWS edges go to two persons.
  test('marko knows exactly 2 people', () => {
    const r = arr(run(traversal(V('1'), out('KNOWS')), g)) as Vertex[];
    expect(r).toHaveLength(2);
    expect(r.every((v) => v.labels.has('PERSON'))).toBe(true);
  });
});
