// An exhaustive PATTERN x FORM matrix across the engines (item 1242).
//
// ⚠️ WHY THIS EXISTS BESIDE THE FUZZER, which already generates these shapes at random: an
// exhaustive small matrix and a random large sample fail DIFFERENTLY. The fuzzer explores wide and
// shallow; a matrix explores a chosen INTERSECTION exhaustively. Item 1236's gap was precisely an
// intersection — paths over flat groups were generated, nested units were generated, and their
// overlap was not — and it hid a wrong answer in BOTH engines for as long as both arms existed.
// Item 1241 then found a second wrong answer (a flat group's group-variable lists coming back
// null) with a 3x12 matrix, after six items of fuzzing had not.
//
// So the matrix is the complement: every pattern family crossed with every projection form, with
// and without a bound path, and the path accessors where a path exists. 144 comparisons, a second
// or so.
//
// ⚠️ AGREEMENT IS THE ASSERTION, NOT CORRECTNESS. Where the engines agree this says they agree —
// item 1237 needed a separate argument (mode-insensitivity) to establish WHICH was right when they
// did not. A failure here means "one of these is wrong", not "TS is wrong"; the shapes with
// hand-verified expectations live in `nested-group-path-conformance.test.ts`.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// Small, and shaped so every family below has several distinct answers: two labels that overlap on
// node 3, a cycle (1->2, 3->2, 3->4, 4->1), a second edge type, and a node whose `s` is absent.
const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1,"s":"a"}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2,"s":"b"}}',
  '{"type":"node","id":"3","labels":["P","Q"],"properties":{"n":3,"s":"c"}}',
  '{"type":"node","id":"4","labels":["Q"],"properties":{"n":4}}',
  '{"type":"node","id":"5","labels":["P"],"properties":{"n":5,"s":"e"}}',
  '{"type":"edge","id":"e1","labels":["KNOWS"],"from":"1","to":"2","properties":{"w":1}}',
  '{"type":"edge","id":"e2","labels":["KNOWS"],"from":"3","to":"2","properties":{"w":2}}',
  '{"type":"edge","id":"e3","labels":["KNOWS"],"from":"3","to":"4","properties":{"w":3}}',
  '{"type":"edge","id":"e4","labels":["LIKES"],"from":"2","to":"4","properties":{"w":4}}',
  '{"type":"edge","id":"e5","labels":["KNOWS"],"from":"4","to":"1","properties":{"w":5}}',
  '{"type":"edge","id":"e6","labels":["LIKES"],"from":"5","to":"1","properties":{"w":6}}',
].join('\n');

/**
 * Each binds `t` as its far endpoint; `{P}` is where a bound-path prefix goes. The third element
 * names an inner GROUP variable where the family has one, so the group-list form below runs only
 * where it means something.
 *
 * ⚠️ THE GROUP-LIST FORM WAS ADDED BY MUTATION, NOT BY DESIGN. The first version of this matrix
 * read the endpoint and the path accessors and never an inner list — so reverting item 1241's fix
 * left all 144 comparisons GREEN, and so did the nested-group conformance file (its group-list
 * case uses a NESTED unit, which routes elsewhere). Item 1241 had therefore shipped with no
 * regression test at all, which only reverting the fix revealed.
 */
const PATTERNS: readonly [string, string, string?][] = [
  ['varlen hop', '{P}(a:P)-[:KNOWS]->{1,2}(t)'],
  ['varlen undirected', '{P}(a:P)-[:KNOWS]-{1,2}(t)'],
  ['varlen multi-type', '{P}(a:P)-[:KNOWS|LIKES]->{1,2}(t)'],
  ['flat group', '{P}((x)-[:KNOWS]->(m)){1,2}(t)', 'x'],
  ['two-hop group', '{P}((x)-[:KNOWS]->(m)-[:LIKES]->(y)){1,2}(t)', 'y'],
  ['reversed group', '{P}((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2}(t)', 'y'],
  ['group, inner edge var', '{P}((x)-[e:KNOWS]->(m)){1,2}(t)', 'm'],
  ['any shortest', '{P}ANY SHORTEST (a:P)-[:KNOWS]->*(t)'],
  ['fixed two hops', '{P}(a:P)-[:KNOWS]->(m)-[:KNOWS]->(t)'],
];

const FORMS: readonly [string, (pat: string) => string][] = [
  ['count', (pat) => `MATCH ${pat} RETURN count(*) AS c`],
  ['endpoint', (pat) => `MATCH ${pat} RETURN t.n AS n`],
  ['endpoint ordered', (pat) => `MATCH ${pat} RETURN t.n AS n ORDER BY n`],
  ['max endpoint', (pat) => `MATCH ${pat} RETURN max(t.n) AS x`],
  ['distinct endpoint', (pat) => `MATCH ${pat} RETURN DISTINCT t.n AS n`],
  ['filtered endpoint', (pat) => `MATCH ${pat} WHERE t.n > 1 RETURN t.n AS n`],
];

const ACCESSORS: readonly [string, string][] = [
  ['path_length', 'path_length(p)'],
  ['cardinality', 'cardinality(p)'],
  ['nodes size', 'size(nodes(p))'],
  ['edges size', 'size(edges(p))'],
];

const suite = nativeReady ? describe : describe.skip;

suite('pattern family x projection form, both engines', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const outcome = (engine: 'ts' | 'native', q: string): string => {
    try {
      const rows = (engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q)) as unknown[];

      // Row order without ORDER BY is unspecified, so compare as a multiset.
      return `${rows.length}r [${[...rows]
        .map((r) => JSON.stringify(r))
        .sort()
        .join('|')}]`;
    } catch (e) {
      return `ERR ${(e as { code?: string } | undefined)?.code ?? 'NO_CODE'}`;
    }
  };

  // One test per pattern family, so a failure names the family rather than "the matrix".
  for (const [pname, pat, innerVar] of PATTERNS) {
    test(`${pname}: every form agrees, with and without a bound path`, () => {
      for (const withPath of [false, true]) {
        const concrete = pat.replace('{P}', withPath ? 'p = ' : '');

        for (const [fname, mk] of FORMS) {
          const q = mk(concrete);

          expect(`${fname} | ${q}\n  ${outcome('ts', q)}`).toBe(
            `${fname} | ${q}\n  ${outcome('native', q)}`,
          );
        }

        // THE GROUP LIST, which is the form that catches item 1241: a flat group's inner lists
        // came back null on the TS side when a path was bound, because `allWalk` binds the
        // endpoint and the Path and none of the unit's variables.
        if (innerVar !== undefined) {
          const q = `MATCH ${concrete} RETURN size(${innerVar}) AS x`;

          expect(`group list | ${q}\n  ${outcome('ts', q)}`).toBe(
            `group list | ${q}\n  ${outcome('native', q)}`,
          );
        }

        if (!withPath) {
          continue;
        }

        for (const [fname, expr] of ACCESSORS) {
          const q = `MATCH ${concrete} RETURN ${expr} AS x`;

          expect(`${fname} | ${q}\n  ${outcome('ts', q)}`).toBe(
            `${fname} | ${q}\n  ${outcome('native', q)}`,
          );
        }
      }
    });
  }

  test('the matrix is the size it claims (a shrunk matrix is a silent coverage loss)', () => {
    // 9 families x (6 forms x 2 path modes + 4 accessors) = 144, plus the group-list form for
    // the 4 families with an inner variable, twice each = 152. Asserted because a matrix that
    // quietly loses a row looks exactly like a matrix that passes.
    const groupFamilies = PATTERNS.filter(([, , inner]) => inner !== undefined).length;

    expect(groupFamilies).toBe(4);
    expect(PATTERNS.length * (FORMS.length * 2 + ACCESSORS.length) + groupFamilies * 2).toBe(152);
  });
});
