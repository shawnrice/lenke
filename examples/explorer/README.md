# graph explorer

An interactive **visual explorer** for a lenke graph: render it as a
force-directed node-link diagram, drag nodes around, click one to inspect its
labels and properties, and run a GQL query to highlight the vertices it matches.

It runs entirely in the browser on the **pure-TypeScript** engine — `@lenke/core`
holds the graph, `@lenke/gql` answers queries — so there's no wasm, no worker,
no server. Like the [service-map](../service-map) example it's deliberately
dependency-light: the layout and rendering are hand-rolled SVG, no graph-viz
library.

## Run it

```sh
bun install
bun run dev       # vite; open the printed URL
```

It opens on the TinkerPop "Modern" sample graph. Use **Load file…** to drop in
your own (`.ndjson` · `.csv` · `.graphson`, decoded by `@lenke/serialization`),
or **Sample** to reset.

Headless check: `bun run e2e` (needs `bunx playwright install chromium` once) —
boots vite and drives it in Chromium, asserting the diagram renders and a query
dims the right vertices.

## Try it

- **Drag** a node — it pins where you drop it while the rest of the layout
  relaxes around it; release to let it float again.
- **Click** a node — the side panel shows its `#id`, labels, and properties.
- **Query to highlight** — type a GQL query that returns a node and press Enter
  (or **Highlight**). Everything it doesn't match fades:

  ```
  MATCH (p:PERSON) WHERE p.age > 30 RETURN p
  MATCH (a:PERSON)-[:CREATED]->(s:SOFTWARE) RETURN s
  ```

  Return the node variable (`RETURN p`) or its id (`RETURN element_id(p)`);
  a property-only projection (`RETURN p.name`) has no node to point at, so it
  highlights nothing.

## How it's built

Three files, each doing one thing:

- **`src/layout.ts`** — a tiny force-directed simulation: repulsion between every
  node, springs along edges, a pull to the origin, integrated with damping. It's
  pure and deterministic (nodes seed on a jittered circle, no RNG), so it's
  unit-tested for convergence. `step()` advances one tick; `main.tsx` calls it on
  each animation frame.
- **`src/model.ts`** — flattens a `@lenke/core` `Graph` into plain nodes/edges to
  render, and turns a GQL query into the set of vertex ids to highlight (by
  scanning the result rows for returned nodes / ids).
- **`src/main.tsx`** — the React view: an SVG of `<line>` edges and `<circle>`
  nodes (colored per label), the pointer handling for drag/select, the query box,
  and the property panel. No component library.

The engine seam is small on purpose: the app only ever calls
`toModel(graph)` and `query(graph, text)`. Swapping in a different graph (a
loaded file, a generated dataset) is just `setGraph(...)`.
