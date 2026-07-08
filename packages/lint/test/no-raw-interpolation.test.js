/* eslint-disable no-template-curly-in-string -- these are lint FIXTURE strings; the `${...}` is deliberate */
// Proves the rule works under ESLint's RuleTester (the canonical rule test), which
// also demonstrates ESLint compatibility — the same rule object oxlint loads via
// `jsPlugins`. Run: bun test packages/lint
import { RuleTester } from 'eslint';

import { noRawInterpolation } from '../rules/no-raw-interpolation.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

// RuleTester.run() registers its own describe()/it() with the ambient test
// framework (bun:test's globals), so it must be called at the top level — not
// wrapped in a test(), which bun forbids nesting a describe() inside.
ruleTester.run('no-raw-interpolation', noRawInterpolation, {
  valid: [
    // Tagged templates — the safe interpolation path (a TaggedTemplateExpression,
    // never a CallExpression, so the rule cannot fire).
    { code: 'g.query`MATCH (n) WHERE n.name = ${x} RETURN n`;' },
    { code: "client.mutateGremlin`g.addV('X').property('n', ${x})`;" },
    { code: "g.gremlin`g.V().has('n', ${x})`;" },
    // `$name` param bag — a static literal + a params object.
    { code: "g.query('MATCH (n) WHERE n.name = $name RETURN n', { name: x });" },
    { code: "client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });" },
    // Static literals and bare variables (a trusted prepared query is indistinguishable).
    { code: "query(g, 'MATCH (n) RETURN n');" },
    { code: 'g.query(prepared);' },
    // Unrelated method named `query` with a concat arg 0 is not the text position.
    { code: "el.querySelector('.' + cls);" },
  ],
  invalid: [
    {
      code: "g.query('MATCH (n) WHERE n.id = ' + userInput + ' RETURN n');",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      code: "g.gremlin('g.V().has(\"name\",' + userInput + ')');",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      code: "client.mutate('INSERT (:X {n:' + userInput + '})');",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      code: "client.mutateGremlin(`g.addV('X').property('n', '${userInput}')`);",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      code: "g.liveGremlin(`g.V().has('n', '${userInput}')`);",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      // The @lenke/gql free function: text is arg 1.
      code: "query(g, 'MATCH (n) RETURN ' + userInput);",
      errors: [{ messageId: 'rawInterpolation' }],
    },
    {
      code: 'g.query(`MATCH (n) WHERE n.id = ${userInput}`);',
      errors: [{ messageId: 'rawInterpolation' }],
    },
  ],
});
