import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, branch, constant, hasLabel, label, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('branch tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Route by label: persons -> name, software -> 'a software'.
  test('branch routes per traverser by test result', () => {
    const r = arr(
      run(
        traversal(
          V(),
          branch(label())
            .option('PERSON', values('name'))
            .option('SOFTWARE', constant('a software')),
        ),
        tinkerGraph,
      ),
    );
    expect(r.sort()).toEqual(['a software', 'a software', 'josh', 'marko', 'peter', 'vadas']);
  });

  // .none(plan) provides a default branch.
  test('branch falls back to .none when no option matches', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          branch(values('age')).option(29, constant('marko')).none(constant('other')),
        ),
        tinkerGraph,
      ),
    );
    // marko=29 -> 'marko'; vadas/josh/peter -> 'other'.
    expect(r.sort()).toEqual(['marko', 'other', 'other', 'other']);
  });

  // doc: g.V().branch(values('name')).option('marko', values('age')).option(none, values('name'))
  //      — 29; vadas; lop; josh; ripple; peter
  test('branch by values("name") with .none default', () => {
    const r = arr(
      run(
        traversal(V(), branch(values('name')).option('marko', values('age')).none(values('name'))),
        tinkerGraph,
      ),
    );
    // marko -> 29; everyone else -> own name
    expect(r.sort()).toEqual([29, 'josh', 'lop', 'peter', 'ripple', 'vadas']);
  });

  // No matching option and no default => traverser dropped.
  test('branch drops traverser with no match and no default', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), branch(values('age')).option(29, constant('marko'))),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });
});
