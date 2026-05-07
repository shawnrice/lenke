import { describe, test } from 'bun:test';

// Stubbed tests for match() — declarative pattern matching with `as`-bound
// fragments. AST + DSL exist; executor throws "match() is not yet implemented".
describe('match tests (stubs)', () => {
  // doc: g.V().match(__.as('a').out('created').as('b'),
  //                   __.as('b').has('name','lop'),
  //                   __.as('b').in('created').as('c'),
  //                   __.as('c').has('age',29)).select('a','c').by('name')
  // expected: [a:marko,c:marko]; [a:josh,c:marko]; [a:peter,c:marko]
  test.skip('TODO match: declarative AND of as-pattern fragments', () => {});

  // doc: g.V().match(__.as('a').out('created').has('name','lop').as('b'),
  //                   __.as('b').in('created').has('age',29).as('c')).select('a','c').by('name')
  test.skip('TODO match: chained pattern with embedded has', () => {});

  // doc: g.V().match(__.as('a').out('created').as('b'),
  //                   __.as('b').in('created').as('c')).where('a',neq('c')).select('a','c').by('name')
  test.skip('TODO match: combined with where(neq) over labels', () => {});

  // doc: g.V().as('a').out('knows').as('b').
  //         match(__.as('b').out('created').as('c'),
  //                __.not(__.as('c').in('created').as('a'))).select('a','b','c').by('name')
  test.skip('TODO match: nested __.not() inside match', () => {});
});
