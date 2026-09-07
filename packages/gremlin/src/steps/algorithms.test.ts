import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import {
  ConnectedComponent,
  connectedComponent,
  dedupe,
  pageRank,
  PageRank,
  peerPressure,
  PeerPressure,
  V,
  values,
  withComputer,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('OLAP algorithm steps — computed locally', () => {
  test('pageRank() writes the default property and passes traversers through', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(traversal(V(), pageRank(), values('gremlin.pageRankVertexProgram.pageRank')), g),
    );
    // One score per vertex, all positive finite numbers.
    expect(r).toHaveLength(6);
    expect(r.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)).toBe(true);
  });

  test('withComputer() is an accepted no-op marker', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          withComputer(),
          V(),
          pageRank(),
          values('gremlin.pageRankVertexProgram.pageRank'),
        ),
        g,
      ),
    );
    expect(r).toHaveLength(6);
  });

  test('pageRank(alpha).with(PageRank.propertyName, …) writes where asked', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(traversal(V(), pageRank(0.85).with(PageRank.propertyName, 'pr'), values('pr')), g),
    );
    expect(r).toHaveLength(6);
    // The default property was not written.
    const dflt = arr(
      run(
        traversal(
          V(),
          pageRank(0.85).with(PageRank.propertyName, 'pr'),
          values('gremlin.pageRankVertexProgram.pageRank'),
        ),
        g,
      ),
    );
    expect(dflt).toHaveLength(0);
  });

  test('connectedComponent() — modern graph is one weakly-connected component', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V(),
          connectedComponent(),
          values('gremlin.connectedComponentVertexProgram.component'),
          dedupe(),
        ),
        g,
      ),
    );
    expect(r).toHaveLength(1);
  });

  test('connectedComponent().with(ConnectedComponent.propertyName, …)', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V(),
          connectedComponent().with(ConnectedComponent.propertyName, 'cc'),
          values('cc'),
        ),
        g,
      ),
    );
    expect(r).toHaveLength(6);
  });

  test('peerPressure() writes cluster labels (external-id strings)', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(traversal(V(), peerPressure(), values('gremlin.peerPressureVertexProgram.cluster')), g),
    );
    expect(r).toHaveLength(6);
    expect(r.every((c) => typeof c === 'string')).toBe(true);
  });

  test('peerPressure().with(PeerPressure.times, 1) caps iterations without error', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V(),
          peerPressure().with(PeerPressure.times, 1),
          values('gremlin.peerPressureVertexProgram.cluster'),
        ),
        g,
      ),
    );
    expect(r).toHaveLength(6);
  });

  test('the .edges modulator restricts the algorithm to that edge label', () => {
    const g = createTestTinkerGraph();
    const prop = 'gremlin.pageRankVertexProgram.pageRank';
    // Restricting to KNOWS edges gives different scores than the all-edges default.
    const all = arr(run(traversal(V(), pageRank(), values(prop)), g))
      .slice()
      .sort();
    const knows = arr(
      run(traversal(V(), pageRank().with(PageRank.edges, 'KNOWS'), values(prop)), g),
    )
      .slice()
      .sort();
    expect(knows).toHaveLength(6);
    expect(knows.every((s) => typeof s === 'number' && Number.isFinite(s))).toBe(true);
    expect(knows).not.toEqual(all);
    // connectedComponent + peerPressure accept it too (no throw).
    expect(() =>
      arr(run(traversal(V(), connectedComponent().with(ConnectedComponent.edges, 'KNOWS')), g)),
    ).not.toThrow();
    expect(() =>
      arr(run(traversal(V(), peerPressure().with(PeerPressure.edges, 'KNOWS')), g)),
    ).not.toThrow();
  });
});
