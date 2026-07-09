# `fp/` — source layout

Internal layout of `@lenke/fp`. The package-level [`@lenke/fp`](../README.md)
README is the combinator catalog and usage guide; this note is for reading the
source.

The convention here is **one combinator per file**, with its test colocated:
`map.ts` + `map.test.ts`, `filter.ts` + `filter.test.ts`, and so on. To find a
combinator, open the file named after it. Adding one means adding a `<name>.ts`,
its `<name>.test.ts`, and an export line in `index.ts` — no central registry to
update.

A few files are shared infrastructure rather than combinators:

- **`index.ts`** — the barrel; the package's public surface is exactly what it
  re-exports.
- **`types.ts`** — the shared function-type aliases (`Predicate`, `MapFn`,
  `SortFn`, `UnaryFn`, …) the combinators and their signatures are built from.
- **`utils.ts`** — internal helpers (iterable/type guards) used across
  combinators, not exported.
- **`pipe.ts`** — left-to-right composition; the spine that makes the data-last
  curried forms compose.
- **`boundary.ts` / `bounded.ts`** — the shared iteration boundary used by the
  slice-family combinators (`take`/`skip`/`window`/…).

Combinators are lazy and iterable-based: they take and return iterables and do
no work until consumed, so a `pipe` of them fuses into a single pass.
