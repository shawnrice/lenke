import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { between, inside, outside } from '../predicates.js';
import { V, has, hasLabel, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('between / inside / outside predicates', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Ages: marko=29, vadas=27, josh=32, peter=35

  test('between is half-open [first, second) — Gremlin semantics', () => {
    // age >= 29 && age < 32 → marko (29). NOT josh (32, excluded).
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('age', between(29, 32)), values('name')),
        tinkerGraph,
      ),
    );
    expect((r as string[]).sort()).toEqual(['marko']);
  });

  test('inside is strict open (first, second)', () => {
    // age > 27 && age < 35 → marko, josh. NOT vadas (27) or peter (35).
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('age', inside(27, 35)), values('name')),
        tinkerGraph,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'marko']);
  });

  test('outside is strict complement: < first || > second', () => {
    // age < 29 || age > 32 → vadas (27), peter (35).
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('age', outside(29, 32)), values('name')),
        tinkerGraph,
      ),
    );
    expect((r as string[]).sort()).toEqual(['peter', 'vadas']);
  });
});
