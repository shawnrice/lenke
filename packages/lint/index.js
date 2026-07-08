// @lenke/lint — shareable lint rules for consumers of the lenke packages.
//
// ONE module, TWO linters: oxlint's `jsPlugins` implement the ESLint plugin API,
// so this same plugin object is loaded by both. The rules are plain ESM (no
// build step) so either linter can import them directly.
//
// Rule prefix is `lenke/` in both (from the plugin `meta.name` under oxlint, and
// from the `plugins: { lenke }` key you register under ESLint flat config).
//
// ── ESLint (flat config, `eslint.config.js`) ────────────────────────────────
//   import lenke from '@lenke/lint';
//   export default [
//     { plugins: { lenke }, rules: { 'lenke/no-raw-interpolation': 'error' } },
//   ];
//   // or, shorthand:  ...lenke.configs.recommended
//
// ── oxlint (`.oxlintrc.json`) ───────────────────────────────────────────────
//   {
//     "jsPlugins": ["@lenke/lint"],
//     "rules": { "lenke/no-raw-interpolation": "error" }
//   }

import { noRawInterpolation } from './rules/no-raw-interpolation.js';

const plugin = {
  meta: { name: 'lenke', version: '1.0.0' },
  rules: {
    'no-raw-interpolation': noRawInterpolation,
  },
};

// ESLint flat-config preset (self-referential, the flat-config idiom).
plugin.configs = {
  recommended: {
    plugins: { lenke: plugin },
    rules: {
      'lenke/no-raw-interpolation': 'error',
    },
  },
};

// eslint-disable-next-line import/no-default-export -- oxlint jsPlugins + ESLint plugins both take a default export
export default plugin;
