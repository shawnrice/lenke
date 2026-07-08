# @lenke/lint

> Shareable lint rules for apps built on lenke. Catches query-injection footguns. Works with **ESLint** and **oxlint** from one rule set.

The lenke query APIs (`@lenke/native`, `@lenke/gql`, `@lenke/sync`) are safe when you interpolate values as a **tagged template** (bound as a GQL `$param`, or escaped into a safe Gremlin literal) or with a **`$name` param bag** — and silently unsafe when you build query text by string concatenation. The API can't tell a trusted literal from attacker input in a string position, so this package lints for the unsafe shape. See [`no-raw-interpolation`](#lenkeno-raw-interpolation).

One rule module serves both linters: oxlint's `jsPlugins` implement the ESLint plugin API, so the exact same plugin is loaded by each. Rules are plain ESM — no build step.

## Install

```sh
npm i -D @lenke/lint
```

## Enable it

### ESLint (flat config — `eslint.config.js`)

```js
import lenke from '@lenke/lint';

export default [
  // the shorthand preset (turns every rule on as "error"):
  lenke.configs.recommended,

  // …or wire it by hand:
  { plugins: { lenke }, rules: { 'lenke/no-raw-interpolation': 'error' } },
];
```

### oxlint (`.oxlintrc.json`)

```json
{
  "jsPlugins": ["@lenke/lint"],
  "rules": { "lenke/no-raw-interpolation": "error" }
}
```

Rules read `lenke/…` under both linters (from the plugin's `meta.name` in oxlint, and from the `plugins: { lenke }` key in ESLint).

## Rules

### `lenke/no-raw-interpolation`

Flags a value spliced into GQL / Gremlin query **text** — an injection risk. Reported when the query-text argument of a lenke query/mutation call (`.query`, `.queryArrow`, `.gremlin`, `.mutate`, `.mutateGremlin`, `.liveQuery`, `.liveGremlin`, and the `@lenke/gql` free `query`) is:

- `+` string concatenation, or
- an interpolated `` `…${x}…` `` template passed as a **plain argument** (note: not a tag — the `${x}` is spliced, not bound).

```ts
// ✗ flagged — value spliced into query text
g.query('MATCH (u:User) WHERE u.name = ' + name + ' RETURN u');
g.query(`MATCH (u:User) WHERE u.id = ${id}`); // interpolated template as a plain arg
client.mutateGremlin(`g.addV('User').property('name', '${name}')`);

// ✓ safe — tagged template (bound for GQL, escaped for Gremlin)
g.query`MATCH (u:User) WHERE u.name = ${name} RETURN u`;
client.mutateGremlin`g.addV('User').property('name', ${name})`;

// ✓ safe — $name param bag
g.query('MATCH (u:User) WHERE u.name = $name RETURN u', { name });
```

The rule is **syntactic** — it keys on the callee's method name and the argument's shape, so an inline concat/interpolation is caught, but a bare variable holding a pre-built query is not (a trusted prepared query is indistinguishable from an unsafe one at the AST level). If the text is genuinely trusted, suppress the line with a disable comment (`// eslint-disable-next-line lenke/no-raw-interpolation` / `// oxlint-disable-next-line lenke/no-raw-interpolation`) explaining why.
