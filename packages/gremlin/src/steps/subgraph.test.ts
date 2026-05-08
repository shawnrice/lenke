import { describe, test } from 'bun:test';

// Stubbed tests for subgraph() — accumulate matching edges into a named
// side-effect subgraph builder. AST + DSL exist; executor throws
// "subgraph() is not yet implemented".
describe('subgraph tests (stubs)', () => {
  // doc: subGraph = g.E().hasLabel('knows').subgraph('subGraph').cap('subGraph').next()
  // expected: tinkergraph[vertices:3 edges:2]
  test.skip('TODO subgraph: collect knows edges via cap', () => {});

  // doc: g.V().outE('knows').subgraph('knowsG').inV().outE('created').subgraph('createdG').
  //         inV().inE('created').subgraph('createdG').iterate()
  test.skip('TODO subgraph: chained accumulation across multiple keys', () => {});
});
