import { describe, test } from 'bun:test';

// Stubbed tests for property() mutation step.
// TODO: property() not yet implemented in v2 (mutation steps as a whole).
describe('property tests (stubs)', () => {
  // doc: g.V(1).property('city','santa fe').property('state','new mexico').valueMap()
  test.skip('TODO property: mutate a vertex property', () => {});

  // doc: g.V(1).property('friendWeight',outE('knows').values('weight').sum(),'acl','private')
  test.skip('TODO property: with sub-traversal value + meta-properties', () => {});
});
