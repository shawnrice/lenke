# @lenke/cli

> A REPL and command-line tool for lenke: load a graph through any codec, query it in **GQL or Gremlin**, and serialize it back out.

For quick analysis and trying queries against a graph file without writing a
script. It runs the Rust engine as WebAssembly, so it works on plain Node or Bun
with no native addon.

## Install / run

In this monorepo it's the `lenke` bin:

```sh
bun run build                     # builds the package + the wasm engine it loads
./packages/cli/bin/lenke.mjs      # or `lenke` once linked / installed
```

The CLI needs the wasm engine (`lenke_core.wasm`). It looks at `$LENKE_WASM`,
then the `--wasm <path>` flag, then the workspace build output — so after
`bun run build:wasm` it just works in-repo.

## The REPL

```sh
lenke                      # empty graph
lenke graph.ndjson         # load a file (codec inferred from the extension)
```

```text
lenke> INSERT (:Person {name: 'marko', age: 29})
(0 rows)
lenke> MATCH (p:Person) RETURN p.name, p.age
┌────────┬───────┐
│ p.name │ p.age │
├────────┼───────┤
│ marko  │ 29    │
└────────┴───────┘
(1 row)
lenke> g.V().hasLabel('Person').count()
┌───────┐
│ value │
├───────┤
│ 1     │
└───────┘
(1 row)
```

A line is run as **Gremlin** when it starts with `g.`, otherwise as **GQL**.
Meta-commands:

| Command              | Does                                          |
| -------------------- | --------------------------------------------- |
| `.describe`          | summarize the graph (labels, counts, indexes) |
| `.gql <query>`       | run as GQL regardless of the leading text     |
| `.gremlin <query>`   | run as Gremlin                                |
| `.load <file> [fmt]` | load a graph (replaces the current one)       |
| `.save <file> [fmt]` | serialize the graph to a file                 |
| `.clear`             | start over with an empty graph                |
| `.help` / `.exit`    | help / quit (Ctrl-D also quits)               |

## One-shot & conversion

```sh
# run a single query and exit
lenke graph.csv -q "MATCH (p:Person) RETURN p.name, p.age"
lenke graph.ndjson -q "g.V().hasLabel('Person').count()"

# convert between codecs (load one, save another)
lenke graph.graphson -o graph.ndjson
```

Codecs (`--format` / `--out-format`, or inferred from the extension):
`ndjson` · `csv` · `graphson` · `pg-json` · `pg-text`. Run `lenke --help` for all
options.

## License

Apache-2.0
