/*
 * Item 2181 — a transaction stops recording touched vertices when NO commit-time check could read them.
 *
 * ```text
 *     four alternated arms, 40 reps, median of the last 15, one shape per process
 *     row                 BEFORE                NEW
 *     SET every row    107.67 / 111.23     58.85 / 60.57     1.83x
 *     SET filtered       7.25 /   6.92      6.49 /  6.54     1.09x  (only 2,062 writes)
 *     read control       3.66 /   4.07      3.74 /  6.25     noise, in BOTH directions
 * ```
 *
 * ⚠️ The first A/B read 1.48x with the read control ALSO moving 1.46x, which is the giveaway of a bogus
 * comparison. Alternating the arm order four times showed the target reproducing (107/111 → 58/60) and the
 * control swinging both ways — so the win is real and was understated.
 *
 * 🔑 **WHAT IT DOES:** inside a transaction `deferConstraint` used to `txTouched.add(vertex.id)`
 * unconditionally, so `runDeferredChecks` could revisit every written vertex at commit. A profile of
 * `SET` over 200,000 vertices on a graph with ZERO constraints put `deferConstraint` at **8.0%** and
 * `runDeferredChecks` at **5.4%** — 13.4% recording ids for a pass with nothing to find.
 *
 * ⚠️⚠️ **THE TESTS THAT MATTER ARE THE ONES BELOW THE FIRST**: every constraint kind must still be caught
 * when it exists. The skip is only sound because `runDeferredChecks` asks exactly three questions
 * (`missingRequired`, `typeViolation`, `uniqueConflict`) plus the validator registry, and each reads only
 * the seven collections `hasDeferrableVertexChecks` tests.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from './index.js';

describe('the deferred-check skip (item 2181)', () => {
  test('🔑 with NO constraints, a transactional write still commits', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.transaction(() => {
      g.getVertexById('a')!.setProperty('n', 9);
    });

    expect(g.getVertexById('a')!.properties.n).toBe(9);
  });

  test('🔑 and a ROLLBACK still restores, which is the undo log rather than the check pass', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });

    expect(() => {
      g.transaction(() => {
        g.getVertexById('a')!.setProperty('n', 9);

        throw new Error('rollback');
      });
    }).toThrow();
    expect(g.getVertexById('a')!.properties.n).toBe(1);
  });

  describe('⚠️⚠️ every constraint kind is still enforced INSIDE a transaction', () => {
    test('⚠️ a REQUIRED constraint', () => {
      const g = new Graph();

      g.createRequiredConstraint('P', 'req');
      g.addVertex({ id: 'b', labels: ['P'], properties: { req: 'x' } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('b')!.setProperty('req', null);
        });
      }).toThrow();
      // ⚠️ And the rollback leaves the old value, not the rejected one.
      expect(g.getVertexById('b')!.properties.req).toBe('x');
    });

    test('⚠️ a UNIQUE constraint', () => {
      const g = new Graph();

      g.createUniqueConstraint('P', 'u');
      g.addVertex({ id: 'x', labels: ['P'], properties: { u: 1 } });
      g.addVertex({ id: 'y', labels: ['P'], properties: { u: 2 } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('y')!.setProperty('u', 1);
        });
      }).toThrow();
      expect(g.getVertexById('y')!.properties.u).toBe(2);
    });

    test('⚠️ a TYPE constraint', () => {
      const g = new Graph();

      g.createTypeConstraint('P', 't', 'string');
      g.addVertex({ id: 'z', labels: ['P'], properties: { t: 'ok' } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('z')!.setProperty('t', 42);
        });
      }).toThrow();
      expect(g.getVertexById('z')!.properties.t).toBe('ok');
    });

    test('⚠️⚠️ a NOT NULL type constraint (vertexTypeNotNull)', () => {
      /*
       * 🔑 ONE OF FOUR KINDS A MUTATION ROUND SHOWED UNTESTED. Dropping `vertexTypeNotNull` from
       * `hasDeferrableVertexChecks` survived every test, which meant the guard's term was unproven, not
       * that it was unnecessary. ⚠️ `'string NOT NULL'` is the spelling that populates it.
       */
      const g = new Graph();

      g.createTypeConstraint('P', 't', 'string NOT NULL');
      g.addVertex({ id: 'n1', labels: ['P'], properties: { t: 'ok' } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('n1')!.setProperty('t', null);
        });
      }).toThrow();
      expect(g.getVertexById('n1')!.properties.t).toBe('ok');
    });

    test('⚠️⚠️ a RECORD type constraint (vertexRecordConstraints)', () => {
      /*
       * 🔑 `createTypeConstraint` routes a non-scalar spec to the parallel record map, so `'RECORD'` is
       * what reaches `vertexRecordConstraints` — the second of the four untested kinds.
       */
      const g = new Graph();

      g.createTypeConstraint('P', 'r', 'RECORD');
      g.addVertex({ id: 'n2', labels: ['P'], properties: { r: { a: 1 } } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('n2')!.setProperty('r', 'not a record');
        });
      }).toThrow();
    });

    test('⚠️⚠️ a VALIDATOR (validatorRegistry)', () => {
      /*
       * 🔑 The third untested kind. A validator that refuses `n > 5` must still refuse inside a
       * transaction — `runDeferredChecks` consults the registry, so the guard must count it.
       */
      const g = new Graph();

      /* ⚠️ `(label, varName, src, fn)` — the validator returns FALSE to reject. */
      g.registerValidator('P', 'v', 'v.n <= 5', (element: unknown) => {
        const n = (element as { properties?: Record<string, unknown> }).properties?.n;

        return !(typeof n === 'number' && n > 5);
      });
      g.addVertex({ id: 'n3', labels: ['P'], properties: { n: 1 } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('n3')!.setProperty('n', 99);
        });
      }).toThrow();
    });

    test('⚠️⚠️ a NEW VERTEX violating a constraint inside a transaction (the addVertex path)', () => {
      /*
       * 🔑🔑 THE PATH ITEM 2184 GUARDED, which item 2181's tests did not reach: `addVertex` has its OWN
       * `txTouched.add`, separate from `deferConstraint`'s. ⚠️ A vertex CREATED inside the transaction must
       * still be checked at commit — this is the test that makes that guard's term load-bearing.
       */
      const g = new Graph();

      g.createRequiredConstraint('P', 'req');

      expect(() => {
        g.transaction(() => {
          g.addVertex({ id: 'fresh', labels: ['P'], properties: { other: 1 } });
        });
      }).toThrow();
      expect(g.getVertexById('fresh')).toBeNull();
    });

    test('⚠️ a new vertex violating a UNIQUE constraint inside a transaction', () => {
      const g = new Graph();

      g.createUniqueConstraint('P', 'u');
      g.addVertex({ id: 'u1', labels: ['P'], properties: { u: 7 } });

      expect(() => {
        g.transaction(() => {
          g.addVertex({ id: 'u2', labels: ['P'], properties: { u: 7 } });
        });
      }).toThrow();
      expect(g.getVertexById('u2')).toBeNull();
    });

    test('🔑 and with NO constraints a new vertex in a transaction commits', () => {
      const g = new Graph();

      g.transaction(() => {
        g.addVertex({ id: 'ok', labels: ['P'], properties: { n: 1 } });
      });

      expect(g.getVertexById('ok')?.properties.n).toBe(1);
    });

    test('⚠️⚠️ a CARDINALITY constraint (vertexCardinalityConstraints)', () => {
      /*
       * 🔑 THE FOURTH UNTESTED KIND, and the one that justifies the guard covering an EDGE-driven path:
       * a vertex lands in `txTouched` when an edge it owns changes, precisely so a cardinality check can
       * revisit its degree. ⚠️ So this test adds an EDGE inside the transaction, not a property.
       *
       * `(label, edgeType, direction, min, max)` — at most one outgoing `E` per `P`.
       */
      const g = new Graph();

      g.addVertex({ id: 'c1', labels: ['P'], properties: {} });
      g.addVertex({ id: 'c2', labels: ['P'], properties: {} });
      g.addVertex({ id: 'c3', labels: ['P'], properties: {} });
      g.addEdge({
        id: 'ce1',
        from: g.getVertexById('c1')!,
        to: g.getVertexById('c2')!,
        labels: ['E'],
        properties: {},
      });
      g.createCardinalityConstraint('P', 'E', 'out', 0, 1);

      expect(() => {
        g.transaction(() => {
          g.addEdge({
            id: 'ce2',
            from: g.getVertexById('c1')!,
            to: g.getVertexById('c3')!,
            labels: ['E'],
            properties: {},
          });
        });
      }).toThrow();
      // ⚠️ And the rollback removed the second edge. (`getEdgeById` answers `null`, not `undefined`.)
      expect(g.getEdgeById('ce2')).toBeNull();
    });

    test('⚠️⚠️ a constraint created INSIDE the open transaction is still honoured', () => {
      /*
       * 🔑🔑 THE REASON `hasDeferrableVertexChecks` IS COMPUTED LIVE AND NOT MEMOIZED. If it were cached
       * at transaction start, this write would be recorded against a stale "no constraints" answer and
       * the commit-time pass would never look at it.
       */
      const g = new Graph();

      g.addVertex({ id: 'c', labels: ['P'], properties: { req: 'x' } });

      expect(() => {
        g.transaction(() => {
          g.createRequiredConstraint('P', 'req');
          g.getVertexById('c')!.setProperty('req', null);
        });
      }).toThrow();
    });

    test('⚠️⚠️ a write BEFORE the constraint is created in the same transaction STILL throws', () => {
      /*
       * 🔑🔑 THE CASE I EXPECTED THE SKIP TO CHANGE, AND IT DOES NOT. The write happens while no check
       * exists, so nothing is recorded — yet creating the constraint validates the EXISTING graph, which
       * already holds the offending null. ⚠️ Measured in both arms: each throws and rolls back to `'x'`.
       *
       * ⚠️ A first version of this test asserted `typeof threw === 'boolean'` — a tautology with no
       * teeth — because I had flagged this as "the one observable difference" and then not pinned it.
       * Both arms were then measured and agree, so the real behaviour is asserted here instead.
       */
      const g = new Graph();

      g.addVertex({ id: 'd', labels: ['P'], properties: { req: 'x' } });

      expect(() => {
        g.transaction(() => {
          g.getVertexById('d')!.setProperty('req', null);
          g.createRequiredConstraint('P', 'req');
        });
      }).toThrow();
      expect(g.getVertexById('d')!.properties.req).toBe('x');
    });
  });

  test('🔑 constraints added AFTER a transaction closes still apply to later writes', () => {
    const g = new Graph();

    g.addVertex({ id: 'e', labels: ['P'], properties: { req: 'x' } });
    g.transaction(() => {
      g.getVertexById('e')!.setProperty('req', 'y');
    });
    g.createRequiredConstraint('P', 'req');

    expect(() => {
      g.transaction(() => {
        g.getVertexById('e')!.setProperty('req', null);
      });
    }).toThrow();
  });
});
