# @pl-graph/dev

> Internal build, lint, and format tooling shared across the `@pl-graph` monorepo.

This package bundles the helpers and configuration that other packages in the monorepo depend on at build and lint time: a library bundler built on rolldown plus the TypeScript compiler, a custom oxlint plugin, and shared base configs for oxlint and oxfmt. It is consumed as a `devDependency` inside the monorepo and is not a published runtime library.

## What's here

- **`buildPackage` (default export)** — a library build orchestrator. Bundles a package's `src/` entrypoints into ESM (and optionally CJS), with optional minified variants, while emitting `.d.ts` declarations via the TypeScript compiler API. Uses rolldown (Rollup semantics) so re-exported implementations survive in `sideEffects: false` packages, externals every bare specifier, and resolves NodeNext `.js` specifiers back to `.ts`/`.tsx` sources.
- **`oxlintrc.base.json`** — the shared oxlint base config: core/import/TypeScript/unicorn rule set, test-file overrides, and registration of the custom lint plugin. Exposed at the `@pl-graph/dev/oxlintrc.base.json` subpath.
- **`oxfmtrc.base.json`** — the shared oxfmt base config (print width 100, single quotes, semicolons, trailing commas, always-parenthesized arrow params). Exposed at the `@pl-graph/dev/oxfmtrc.base.json` subpath.
- **`lint-rules/padding-lines.js`** — a custom oxlint JS plugin (`padding-lines/before-exit`) that enforces blank lines around block statements (`if`/`for`/`while`/`switch`/`try`) and before exit statements (`return`, `throw`, standalone `yield*`). Auto-fixable.

## Usage

A package's `build.ts` calls `buildPackage`, pointing it at the package root:

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '@pl-graph/dev';

const __dirname = dirname(fileURLToPath(import.meta.url));

await buildPackage({
  packageRoot: __dirname,
  skipCjs: true,
  skipMin: true,
});
```

`buildPackage` accepts a `PackageConfig`:

- `packageRoot` — package directory (default `process.cwd()`).
- `additionalEntrypoints` — extra entrypoints beyond `src/index.ts`.
- `perFile` — build every non-test `.ts` file under `src/` as its own entrypoint instead of just the barrel.
- `skipTypes` / `skipEsm` / `skipCjs` / `skipMin` — opt out of declaration, ESM, CJS, and minified outputs respectively.
- `typesConfigPath` — tsconfig used for declaration emit (default `tsconfig.types.json`).

Outputs land in `dist/esm`, `dist/esm.min`, `dist/cjs`, `dist/cjs.min`, and `dist/types`.

The base configs are consumed by `extends` and re-export. A root `.oxlintrc.json` references the lint base:

```json
{
  "extends": ["./packages/dev/oxlintrc.base.json"]
}
```

and the oxfmt base is mirrored (or pointed at) from the root oxfmt config. Both are resolvable via their package subpaths, e.g. `@pl-graph/dev/oxlintrc.base.json`.

## License

Apache-2.0
