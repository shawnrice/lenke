# `list/` — source layout

Internal layout of `@lenke/list`. The package-level [`@lenke/list`](../README.md)
README is the API reference; this note is for reading the source.

- **`List.ts`** — the `List<T>` class: a lazy, iterator-backed sequence. It wraps
  a generator (plus an optional known `length`) and its instance methods (`map`,
  `filter`, `take`, `sort`, …) each return a new `List` without walking the
  source until it's iterated.
- **`functions/`** — the static constructors and guards, one per file:
  `of`, `from`, `empty`, `isList`, and `isGeneratorFunction` (which lets
  `List.from` accept a generator function as well as an iterable). Colocated
  tests (`of.test.ts`, …) follow the same one-per-file convention.
- **`types.ts`** — the shared type aliases (e.g. `ListFn`), built on `@lenke/fp`'s
  function types.
- **`index.ts`** — the barrel; the public surface is what it re-exports.

Laziness is the point: methods build a pipeline of generators and nothing runs
until the `List` is consumed (`toArray`, `for…of`, spread), so chained transforms
fuse into a single pass.
