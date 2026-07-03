import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Codec } from '../codec.js';
import type { ChunkSource } from '../streaming.js';
import { linesFromChunks } from '../streaming.js';
import { normalizeBag } from '../value.js';
import type { PropertyValue } from '../value.js';

/**
 * CSV codec for the core LPG model — a Neo4j-`admin-import`-style pair of typed
 * CSVs (one for nodes, one for edges). This codec speaks the core `Graph` API
 * directly; it never touches the GQL or Gremlin layers, and encodes exactly the
 * shared `PropertyValue` model. Values are normalized at the boundary via
 * `normalizeBag` (see `value.ts` for the single definition of property-value
 * lossiness).
 *
 * ## File shapes
 *
 * **nodes.csv** — columns:
 *   - `id`         the node's string id
 *   - `:LABEL`     the label *set*, `;`-joined for multi-label; empty = no labels
 *   - then one **typed** column per property key seen across *all* nodes (the
 *     header is the union of keys), header `key:type` where
 *     `type ∈ string | integer | float | boolean`, and list-valued columns use
 *     `key:integer[]` / `key:string[]` / … with elements `;`-joined.
 *
 * **edges.csv** — columns:
 *   - `id`         the edge's string id
 *   - `:START_ID`  the from-node id
 *   - `:END_ID`    the to-node id
 *   - `:TYPE`      the single edge label
 *   - then typed property columns exactly as for nodes.
 *
 * Because label/property *sets* are heterogeneous across elements, every header
 * is the union of all keys seen; an element that lacks a column's key encodes
 * that cell as **absent** (see the representation table below).
 *
 * ## Typing rules
 *
 * The per-column type is inferred from the *first non-null, non-absent* value
 * seen for that key across all elements (scanning in iteration order):
 *   - `boolean` — the value `true` / `false`
 *   - `integer` — a number with `Number.isInteger(n)`
 *   - `float`   — any other finite number
 *   - `string`  — a string
 *   - `…[]`     — an array; the element type is inferred from the array's first
 *                 element (empty arrays default to `string[]`)
 * On decode the column type drives reconstruction, so the exact `PropertyValue`
 * (int vs float vs bool vs string, and list element type) survives the round
 * trip.
 *
 * **Heterogeneous keys.** A real LPG graph may use the same key with different
 * types on different elements (e.g. `tags` is a list on one node and a string
 * on another). A single typed column cannot describe that, so a cell whose
 * concrete type differs from its column's declared type carries an inline
 * **type-override sigil**: the raw cell is prefixed with `\T<code>:`, where
 * `<code> ∈ s | i | f | b` for scalars and `<code>[]` for lists (e.g. `\Ti:`
 * for an integer cell in a string column, `\Ts[]:5;6` for a string list). The
 * sigil only appears on deviating cells, so the common homogeneous case stays
 * clean while heterogeneous graphs still round-trip exactly.
 *
 * ## The null / empty-string / absent distinction (the hard part)
 *
 * A stringly-typed CSV cell must encode three logically distinct states, so we
 * pick three distinct on-the-wire representations:
 *
 *   | logical state                       | cell on the wire        |
 *   | ----------------------------------- | ----------------------- |
 *   | property **absent** (key not on el) | empty, unquoted  →  ``  |
 *   | property present, value `null`      | the token  `\N`         |
 *   | property present, value `''`        | quoted empty     →  `""` |
 *
 * `\N` is Neo4j's conventional null sentinel and is emitted unquoted. Sentinels
 * (the `\N` null token and the `\T…` type-override sigil below) always begin
 * with a **single** leading backslash. A genuine scalar-string value is always
 * force-quoted *and* has any leading backslash **doubled** on encode (`\x` →
 * `\\x`), so a literal string whose value happens to be `\N` or `\Ti:5` can
 * never be mistaken for a sentinel; decode strips exactly one leading backslash
 * from a quoted string cell. This three-way split is what lets a sparse,
 * heterogeneous graph round-trip: a node that simply lacks a key gets an empty
 * unquoted cell and therefore does **not** gain a spurious `null` for it, while
 * a present empty string is a quoted empty cell and an empty list is likewise
 * quoted (so it is not read back as absent).
 *
 * ## RFC 4180 escaping
 *
 * A field is wrapped in double quotes iff it contains `,`, `"`, CR, LF, or
 * (within a list cell) the `;` element separator; internal `"` are doubled.
 * Parsing is single-pass and quote-aware — never a naive `split(',')`.
 *
 * ## Other lossiness
 *
 * - **Ids** are strings in the core model and are preserved verbatim.
 * - **Label order** is not significant (labels are sets) and is not guaranteed.
 * - **Edge labels**: the core model allows a label *set* on an edge, but the
 *   `:TYPE` column holds a single label. We emit the labels `;`-joined into
 *   `:TYPE` and split them back on decode, so multi-label edges do round-trip.
 */

// ---------------------------------------------------------------------------
// Shared low-level CSV plumbing
// ---------------------------------------------------------------------------

const NULL_TOKEN = '\\N';
const LIST_SEP = ';';

/** A single column's inferred scalar type. */
type ScalarType = 'string' | 'integer' | 'float' | 'boolean';

/** A column type: a scalar, or a homogeneous list of one scalar element type. */
type ColumnType = { readonly scalar: ScalarType; readonly list: boolean };

/** Quote a raw field per RFC 4180 if it contains a delimiter, quote, or newline. */
const quoteField = (raw: string): string => {
  if (
    raw.includes(',') ||
    raw.includes('"') ||
    raw.includes('\n') ||
    raw.includes('\r') ||
    raw.includes(LIST_SEP)
  ) {
    return `"${raw.replaceAll('"', '""')}"`;
  }

  return raw;
};

/**
 * Single-pass RFC-4180 row parser. Returns rows of *parsed cells*, where each
 * cell carries whether it was quoted (needed to tell `''` from absent/`\N`).
 */
type Cell = { readonly text: string; readonly quoted: boolean };

const parseCsv = (input: string): Cell[][] => {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false; // whether the current field used quoting at all
  let inQuotes = false;
  let i = 0;
  const n = input.length;

  const pushField = (): void => {
    row.push({ text: field, quoted });
    field = '';
    quoted = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }

        inQuotes = false;
        i += 1;
        continue;
      }

      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      quoted = true;
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }

    if (c === '\r') {
      // swallow CR; CRLF handled by the LF branch
      i += 1;
      continue;
    }

    if (c === '\n') {
      pushRow();
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  // Flush trailing field/row unless input ended exactly on a newline boundary
  // with nothing buffered.
  if (field.length > 0 || quoted || row.length > 0) {
    pushRow();
  }

  return rows;
};

// ---------------------------------------------------------------------------
// Type inference and scalar (de)serialization
// ---------------------------------------------------------------------------

const scalarOf = (value: Exclude<PropertyValue, readonly PropertyValue[]>): ScalarType => {
  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'float';
  }

  return 'string';
};

/** Infer a column type from one representative (non-null) value. */
const inferColumn = (value: PropertyValue): ColumnType => {
  if (Array.isArray(value)) {
    const [first] = value;
    const scalar =
      first === undefined || first === null || Array.isArray(first) ? 'string' : scalarOf(first);

    return { scalar, list: true };
  }

  return {
    scalar: scalarOf(value as Exclude<PropertyValue, readonly PropertyValue[]>),
    list: false,
  };
};

const columnHeader = (key: string, type: ColumnType): string =>
  `${key}:${type.scalar}${type.list ? '[]' : ''}`;

/** Parse a `key:type[]?` header into its key and column type. */
const parseHeader = (header: string): { key: string; type: ColumnType } => {
  const colon = header.lastIndexOf(':');
  const key = header.slice(0, colon);
  let typePart = header.slice(colon + 1);
  const list = typePart.endsWith('[]');

  if (list) {
    typePart = typePart.slice(0, -2);
  }

  return { key, type: { scalar: typePart as ScalarType, list } };
};

/** Serialize one scalar to its raw (pre-quoting) string form. */
const scalarToRaw = (scalar: ScalarType, value: PropertyValue): string => {
  if (scalar === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
};

/** Parse one raw scalar string back into a `PropertyValue` of the column type. */
const rawToScalar = (scalar: ScalarType, raw: string): PropertyValue => {
  switch (scalar) {
    case 'boolean':
      return raw === 'true';
    case 'integer':
    case 'float':
      return Number(raw);
    default:
      return raw;
  }
};

const SCALAR_CODE: Record<ScalarType, string> = {
  string: 's',
  integer: 'i',
  float: 'f',
  boolean: 'b',
};
const CODE_SCALAR: Record<string, ScalarType> = {
  s: 'string',
  i: 'integer',
  f: 'float',
  b: 'boolean',
};
const OVERRIDE_PREFIX = '\\T';

const typeCode = (type: ColumnType): string =>
  `${SCALAR_CODE[type.scalar]}${type.list ? '[]' : ''}`;

const sameType = (a: ColumnType, b: ColumnType): boolean =>
  a.scalar === b.scalar && a.list === b.list;

// Within a list cell, escape the element separator and the escape char itself
// so string elements may contain a literal `;`.
const escapeElement = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll(LIST_SEP, '\\;');

/** Split a list cell on unescaped `;` separators, unescaping `\;` and `\\` inline. */
const splitList = (raw: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let i = 0;

  while (i < raw.length) {
    const c = raw[i];

    if (c === '\\' && i + 1 < raw.length) {
      cur += raw[i + 1];
      i += 2;
      continue;
    }

    if (c === LIST_SEP) {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }

    cur += c;
    i += 1;
  }

  out.push(cur);

  return out;
};

const scalarOfElement = (el: PropertyValue): ScalarType =>
  el === null || Array.isArray(el)
    ? 'string'
    : scalarOf(el as Exclude<PropertyValue, readonly PropertyValue[]>);

/** Serialize one list element, type-tagging it when it deviates from the column element type. */
const elementToRaw = (elemScalar: ScalarType, el: PropertyValue): string => {
  const actual = scalarOfElement(el);
  const raw = scalarToRaw(actual, el);

  if (actual === elemScalar) {
    return escapeElement(raw);
  }

  return escapeElement(`${OVERRIDE_PREFIX}${SCALAR_CODE[actual]}:${raw}`);
};

/** Parse one (already unescaped) list element back, honoring any type tag. */
const rawToElement = (elemScalar: ScalarType, part: string): PropertyValue => {
  if (part.startsWith(OVERRIDE_PREFIX)) {
    const colon = part.indexOf(':');
    const code = part.slice(OVERRIDE_PREFIX.length, colon);

    return rawToScalar(CODE_SCALAR[code], part.slice(colon + 1));
  }

  return rawToScalar(elemScalar, part);
};

/** Serialize a value (already known non-null) of an exact column type to raw text. */
const valueToRaw = (type: ColumnType, value: PropertyValue): string => {
  if (type.list) {
    return (value as readonly PropertyValue[])
      .map((el) => elementToRaw(type.scalar, el))
      .join(LIST_SEP);
  }

  return scalarToRaw(type.scalar, value);
};

/** Parse raw text of an exact column type back into a value. */
const rawToValue = (type: ColumnType, raw: string): PropertyValue => {
  if (type.list) {
    return raw === '' ? [] : splitList(raw).map((part) => rawToElement(type.scalar, part));
  }

  return rawToScalar(type.scalar, raw);
};

/**
 * Encode a single property cell to its raw (pre-quoting) field plus a flag for
 * whether quoting must be forced (the empty-string case, so it is not read back
 * as absent/null). When the value's concrete type differs from the column type,
 * an inline `\T<code>:` override sigil is prepended. Returns `null` only never;
 * absence is handled by the caller (a key not present on the element).
 */
const encodeCell = (
  column: ColumnType,
  value: PropertyValue,
): { raw: string; forceQuote: boolean } => {
  if (value === null) {
    return { raw: NULL_TOKEN, forceQuote: false };
  }

  const actual = inferColumn(value);

  if (sameType(actual, column)) {
    if (column.scalar === 'string' && !column.list) {
      // Scalar strings are always force-quoted: this distinguishes a present
      // empty string from an absent cell, and a leading backslash is doubled
      // (`\x` → `\\x`) so a literal `\N` / `\T…` can never be read as a
      // sentinel. Decode strips exactly one leading backslash.
      const s = value as string;
      const raw = s.startsWith('\\') ? `\\${s}` : s;

      return { raw, forceQuote: true };
    }

    const raw = valueToRaw(column, value);

    // A present value that renders empty (e.g. an empty list) must be quoted so
    // it is not read back as absent.
    return { raw, forceQuote: raw === '' };
  }

  // Heterogeneous cell: tag with its concrete type so decode can recover it.
  const raw = `${OVERRIDE_PREFIX}${typeCode(actual)}:${valueToRaw(actual, value)}`;

  return { raw, forceQuote: false };
};

/**
 * Decode a parsed cell back into either a `PropertyValue` or the `ABSENT`
 * marker (the key is not present on this element).
 */
const ABSENT = Symbol('absent');

const decodeCell = (column: ColumnType, cell: Cell): PropertyValue | typeof ABSENT => {
  // Quoting is the *only* discriminator we need from the parser, and it is used
  // for exactly two things: telling an absent cell (unquoted empty) from a
  // present empty string (quoted empty), and protecting a genuine scalar-string
  // value that happens to look like a sentinel (always force-quoted on encode).
  const { text } = cell;

  // Absent is the only state that requires an *unquoted* empty cell.
  if (!cell.quoted && text === '') {
    return ABSENT;
  }

  // Sentinels (null, type-override) start with a *single* leading backslash and
  // are recognized regardless of quoting (an override is quoted when its inner
  // value carries a delimiter). Genuine scalar strings that begin with a
  // backslash are escaped to a *double* leading backslash on encode, so they
  // can never collide with a sentinel. A doubled `\\…` therefore is not a
  // sentinel; it is a literal string handled in the string branch below.
  const sentinel = text.startsWith('\\') && !text.startsWith('\\\\');

  if (sentinel && text === NULL_TOKEN) {
    return null;
  }

  if (sentinel && text.startsWith(OVERRIDE_PREFIX)) {
    const colon = text.indexOf(':');
    let code = text.slice(OVERRIDE_PREFIX.length, colon);
    const list = code.endsWith('[]');

    if (list) {
      code = code.slice(0, -2);
    }

    const overrideType: ColumnType = { scalar: CODE_SCALAR[code], list };

    return rawToValue(overrideType, text.slice(colon + 1));
  }

  // A scalar-string cell is a literal string: undo the leading-backslash escape.
  if (column.scalar === 'string' && !column.list) {
    return text.startsWith('\\') ? text.slice(1) : text;
  }

  return rawToValue(column, text);
};

// ---------------------------------------------------------------------------
// Column-set computation (header = union of all keys)
// ---------------------------------------------------------------------------

/** Compute the ordered key list and per-key column type across a set of bags. */
const computeColumns = (
  bags: Iterable<Record<string, PropertyValue>>,
): { keys: string[]; types: Map<string, ColumnType> } => {
  const keys: string[] = [];
  const types = new Map<string, ColumnType>();
  const seen = new Set<string>();

  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      const value = bag[key]!;

      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }

      // The column type is fixed by the first non-null value seen for the key,
      // in iteration order. A null sighting is not informative, so we keep
      // looking until a typed value appears (or the key stays untyped → string).
      if (value !== null && !types.has(key)) {
        types.set(key, inferColumn(value));
      }
    }
  }

  // Any key only ever seen as null defaults to a string column.
  for (const key of keys) {
    if (!types.has(key)) {
      types.set(key, { scalar: 'string', list: false });
    }
  }

  return { keys, types };
};

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

const buildRow = (
  fixed: readonly string[],
  keys: readonly string[],
  types: Map<string, ColumnType>,
  bag: Record<string, PropertyValue>,
): string => {
  const cells: string[] = fixed.map(quoteField);

  for (const key of keys) {
    if (!(key in bag)) {
      cells.push(''); // absent
      continue;
    }

    const encoded = encodeCell(types.get(key)!, bag[key]);
    cells.push(
      encoded.forceQuote ? `"${encoded.raw.replaceAll('"', '""')}"` : quoteField(encoded.raw),
    );
  }

  return cells.join(',');
};

// ---------------------------------------------------------------------------
// Header parsing + per-row decoding (shared by batch and streaming decode)
// ---------------------------------------------------------------------------

type ParsedHeader = { key: string; type: ColumnType };

/** Parse the property columns out of a header row, dropping `fixedCount` leading columns. */
const propColsFromHeader = (headerRow: Cell[], fixedCount: number): ParsedHeader[] =>
  headerRow.slice(fixedCount).map((cell) => parseHeader(cell.text));

/** Decode the property columns of one parsed row (after `fixedCount` fixed columns). */
const propsFromRow = (
  row: Cell[],
  propCols: readonly ParsedHeader[],
  fixedCount: number,
): Record<string, PropertyValue> => {
  const properties: Record<string, PropertyValue> = {};

  for (let c = 0; c < propCols.length; c += 1) {
    const cell = row[c + fixedCount];

    if (cell === undefined) {
      continue;
    }

    const { key, type } = propCols[c];
    const decoded = decodeCell(type, cell);

    if (decoded !== ABSENT) {
      properties[key] = decoded;
    }
  }

  return properties;
};

// Join a label set, escaping `;`/`\` inside each label (same scheme as list
// elements) so a label containing the `;` separator round-trips.
const joinLabels = (labels: Iterable<string>): string =>
  [...labels].map(escapeElement).join(LIST_SEP);

const splitLabels = (text: string): string[] => (text === '' ? [] : splitList(text));

/** Add one vertex from a parsed node row. */
const applyNodeRow = (graph: Graph, row: Cell[], propCols: readonly ParsedHeader[]): void => {
  graph.addVertex({
    id: row[0].text,
    labels: splitLabels(row[1].text),
    properties: propsFromRow(row, propCols, 2),
  });
};

/** Add one edge from a parsed edge row, creating endpoints on demand. */
const applyEdgeRow = (graph: Graph, row: Cell[], propCols: readonly ParsedHeader[]): void => {
  const fromId = row[1].text;
  const toId = row[2].text;
  // Endpoints are created if missing so the edge stream can be decoded without a
  // prior node-decode pass having materialized every referenced vertex.
  const from =
    graph.getVertexById(fromId) ?? graph.addVertex({ id: fromId, labels: [], properties: {} });
  const to = graph.getVertexById(toId) ?? graph.addVertex({ id: toId, labels: [], properties: {} });
  graph.addEdge({
    id: row[0].text,
    from,
    to,
    labels: splitLabels(row[3].text),
    properties: propsFromRow(row, propCols, 4),
  });
};

// ---------------------------------------------------------------------------
// Public natural API: nodes
// ---------------------------------------------------------------------------

/** Encode the graph's vertices to a typed nodes CSV. */
export const encodeNodes = (graph: Graph): string => {
  const bags: Record<string, PropertyValue>[] = [];

  for (const vertex of graph.vertices) {
    bags.push(normalizeBag(vertex.properties));
  }

  const { keys, types } = computeColumns(bags);

  const header = ['id', ':LABEL', ...keys.map((k) => columnHeader(k, types.get(k)!))].join(',');

  const rows: string[] = [header];
  let i = 0;

  for (const vertex of graph.vertices) {
    const labelStr = joinLabels(vertex.labels);
    rows.push(buildRow([vertex.id, labelStr], keys, types, bags[i]));
    i += 1;
  }

  return rows.join('\n');
};

/** Decode a typed nodes CSV into `graph` (mutating it) and return it. */
const decodeNodeRows = (rows: Cell[][], graph: Graph): Graph => {
  if (rows.length === 0) {
    return graph;
  }

  const propCols = propColsFromHeader(rows[0], 2);

  const eventsEnabled = graph.eventsEnabled();

  if (eventsEnabled) {
    graph.disableEvents();
  }

  for (let r = 1; r < rows.length; r += 1) {
    applyNodeRow(graph, rows[r], propCols);
  }

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

export const decodeNodes = (csv: string, graph: Graph): Graph =>
  decodeNodeRows(parseCsv(csv), graph);

// ---------------------------------------------------------------------------
// Public natural API: edges
// ---------------------------------------------------------------------------

/** Encode the graph's edges to a typed edges CSV. */
export const encodeEdges = (graph: Graph): string => {
  const bags: Record<string, PropertyValue>[] = [];

  for (const edge of graph.edges) {
    bags.push(normalizeBag(edge.properties));
  }

  const { keys, types } = computeColumns(bags);

  const header = [
    'id',
    ':START_ID',
    ':END_ID',
    ':TYPE',
    ...keys.map((k) => columnHeader(k, types.get(k)!)),
  ].join(',');

  const rows: string[] = [header];
  let i = 0;

  for (const edge of graph.edges) {
    const typeStr = joinLabels(edge.labels);
    rows.push(buildRow([edge.id, edge.from.id, edge.to.id, typeStr], keys, types, bags[i]));
    i += 1;
  }

  return rows.join('\n');
};

/**
 * Decode a typed edges CSV into `graph` (mutating it) and return it. Nodes must
 * already be present; throws if an edge references an absent vertex id.
 */
const decodeEdgeRows = (rows: Cell[][], graph: Graph): Graph => {
  if (rows.length === 0) {
    return graph;
  }

  const propCols = propColsFromHeader(rows[0], 4);

  const eventsEnabled = graph.eventsEnabled();

  if (eventsEnabled) {
    graph.disableEvents();
  }

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const fromId = row[1].text;
    const toId = row[2].text;

    // Batch decode is strict: endpoints must already exist (nodes were decoded
    // first). The streaming edge decoder, by contrast, creates them on demand.
    if (!graph.getVertexById(fromId) || !graph.getVertexById(toId)) {
      throw new LenkeError(
        `csv: edge references a non-existent vertex (from=${fromId}, to=${toId})`,
        {
          code: ErrorCode.MissingVertex,
          details: { from: fromId, to: toId },
        },
      );
    }

    applyEdgeRow(graph, row, propCols);
  }

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

export const decodeEdges = (csv: string, graph: Graph): Graph =>
  decodeEdgeRows(parseCsv(csv), graph);

// ---------------------------------------------------------------------------
// Streaming (slurp/dump a large graph without holding the whole CSV in memory)
// ---------------------------------------------------------------------------

/** Rows per emitted chunk: a batch is built with array-push + `join('\n')`. */
const BATCH = 1024;

const nodeHeaderLine = (keys: readonly string[], types: Map<string, ColumnType>): string =>
  ['id', ':LABEL', ...keys.map((k) => columnHeader(k, types.get(k)!))].join(',');

const edgeHeaderLine = (keys: readonly string[], types: Map<string, ColumnType>): string =>
  ['id', ':START_ID', ':END_ID', ':TYPE', ...keys.map((k) => columnHeader(k, types.get(k)!))].join(
    ',',
  );

/**
 * Stream the typed nodes CSV. The header is the key-union over *all* vertices,
 * so one upfront pass normalizes every bag to compute it; rows are then yielded
 * in batches of `BATCH`, each batch joined with `\n`. A trailing newline ends
 * every yielded chunk so chunks concatenate into a valid line-oriented document.
 */
export async function* encodeNodesStream(graph: Graph): AsyncGenerator<string> {
  const bags: Record<string, PropertyValue>[] = [];

  for (const vertex of graph.vertices) {
    bags.push(normalizeBag(vertex.properties));
  }

  const { keys, types } = computeColumns(bags);

  yield `${nodeHeaderLine(keys, types)}\n`;

  let batch: string[] = [];
  let i = 0;

  for (const vertex of graph.vertices) {
    batch.push(buildRow([vertex.id, joinLabels(vertex.labels)], keys, types, bags[i]));
    i += 1;

    if (batch.length >= BATCH) {
      yield `${batch.join('\n')}\n`;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield `${batch.join('\n')}\n`;
  }
}

/** Stream the typed edges CSV (same batching strategy as {@link encodeNodesStream}). */
export async function* encodeEdgesStream(graph: Graph): AsyncGenerator<string> {
  const bags: Record<string, PropertyValue>[] = [];

  for (const edge of graph.edges) {
    bags.push(normalizeBag(edge.properties));
  }

  const { keys, types } = computeColumns(bags);

  yield `${edgeHeaderLine(keys, types)}\n`;

  let batch: string[] = [];
  let i = 0;

  for (const edge of graph.edges) {
    batch.push(
      buildRow([edge.id, edge.from.id, edge.to.id, joinLabels(edge.labels)], keys, types, bags[i]),
    );
    i += 1;

    if (batch.length >= BATCH) {
      yield `${batch.join('\n')}\n`;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield `${batch.join('\n')}\n`;
  }
}

/**
 * A CSV record may span several physical lines when a quoted field contains an
 * embedded newline. `linesFromChunks` splits blindly on `\n`, so we reassemble:
 * a record is complete once its accumulated text holds an even number of
 * double-quotes (a `""` escaped quote contributes two and stays even). This is
 * the only place streaming differs from the batch parser's whole-string scan.
 */
const countQuotes = (s: string): number => {
  let n = 0;

  for (const ch of s) {
    if (ch === '"') {
      n += 1;
    }
  }

  return n;
};

/** Yield complete CSV records (each a single `parseCsv`-able string) from raw lines. */
const recordsFromLines = async function* (lines: AsyncGenerator<string>): AsyncGenerator<string> {
  let pending = '';
  let quotes = 0;

  for await (const line of lines) {
    pending = pending === '' ? line : `${pending}\n${line}`;
    quotes += countQuotes(line);

    if (quotes % 2 === 0) {
      yield pending;
      pending = '';
      quotes = 0;
    }
  }

  if (pending !== '') {
    yield pending;
  }
};

const parseRow = (record: string): Cell[] => parseCsv(record)[0] ?? [];

/**
 * Decode a streamed nodes CSV into `graph`. Reads the first record as the typed
 * header, then applies each subsequent row via `addVertex` — never buffering
 * more than one record at a time.
 */
export const decodeNodesStream = async (source: ChunkSource, graph: Graph): Promise<Graph> => {
  const eventsEnabled = graph.eventsEnabled();

  if (eventsEnabled) {
    graph.disableEvents();
  }

  let propCols: ParsedHeader[] | null = null;

  for await (const record of recordsFromLines(linesFromChunks(source))) {
    if (propCols === null) {
      propCols = propColsFromHeader(parseRow(record), 2);
      continue;
    }

    if (record === '') {
      continue;
    }

    applyNodeRow(graph, parseRow(record), propCols);
  }

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

/**
 * Decode a streamed edges CSV into `graph`. Like {@link decodeNodesStream}, but
 * applies edge rows; endpoints are created on demand if not already present.
 */
export const decodeEdgesStream = async (source: ChunkSource, graph: Graph): Promise<Graph> => {
  const eventsEnabled = graph.eventsEnabled();

  if (eventsEnabled) {
    graph.disableEvents();
  }

  let propCols: ParsedHeader[] | null = null;

  for await (const record of recordsFromLines(linesFromChunks(source))) {
    if (propCols === null) {
      propCols = propColsFromHeader(parseRow(record), 4);
      continue;
    }

    if (record === '') {
      continue;
    }

    applyEdgeRow(graph, parseRow(record), propCols);
  }

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

// ---------------------------------------------------------------------------
// Codec-conformant single-string adapter
// ---------------------------------------------------------------------------

/** Sentinel line separating the nodes CSV from the edges CSV in the combined form. */
const SEPARATOR = '\n=== EDGES ===\n';
/** The sentinel as a single line (no surrounding newlines), used by the line-oriented stream. */
const SENTINEL_LINE = '=== EDGES ===';

/** Encode a graph to a single string: nodes CSV, sentinel, edges CSV. */
export const encode = (graph: Graph): string =>
  `${encodeNodes(graph)}${SEPARATOR}${encodeEdges(graph)}`;

/** Decode the combined single-string form into `graph` (nodes first, then edges). */
export const decode = (input: string, graph: Graph): Graph => {
  // Parse the whole document first (quote-aware), THEN split at the sentinel
  // *row* — a lone unquoted `=== EDGES ===` cell. Slicing the raw string on the
  // literal sentinel would fire inside a quoted property value containing
  // `\n=== EDGES ===\n`, truncating the nodes section mid-field; a row-level
  // split cannot be fooled this way.
  const rows = parseCsv(input);
  const split = rows.findIndex(
    (r) => r.length === 1 && !r[0].quoted && r[0].text === SENTINEL_LINE,
  );
  const nodeRows = split === -1 ? rows : rows.slice(0, split);
  const edgeRows = split === -1 ? [] : rows.slice(split + 1);
  decodeNodeRows(nodeRows, graph);
  decodeEdgeRows(edgeRows, graph);

  return graph;
};

/**
 * Stream the combined single-string form: the nodes stream, then the sentinel
 * line, then the edges stream. Each piece already ends in `\n`, so the sentinel
 * lands on its own line between the two sub-documents.
 */
export async function* encodeStream(graph: Graph): AsyncGenerator<string> {
  yield* encodeNodesStream(graph);

  yield `${SENTINEL_LINE}\n`;

  yield* encodeEdgesStream(graph);
}

/**
 * Decode the combined stream incrementally over a single pass of lines: node
 * records up to the sentinel, then the edges header and edge records — never
 * buffering the whole input (only one CSV record at a time).
 */
export const decodeStream = async (source: ChunkSource, graph: Graph): Promise<Graph> => {
  const eventsEnabled = graph.eventsEnabled();

  if (eventsEnabled) {
    graph.disableEvents();
  }

  const records = recordsFromLines(linesFromChunks(source));
  let nodeCols: ParsedHeader[] | null = null;
  let edgeCols: ParsedHeader[] | null = null;
  let inEdges = false;

  for await (const record of records) {
    if (record === SENTINEL_LINE) {
      inEdges = true;
      continue;
    }

    if (!inEdges) {
      if (nodeCols === null) {
        nodeCols = propColsFromHeader(parseRow(record), 2);
        continue;
      }

      if (record !== '') {
        applyNodeRow(graph, parseRow(record), nodeCols);
      }

      continue;
    }

    if (edgeCols === null) {
      edgeCols = propColsFromHeader(parseRow(record), 4);
      continue;
    }

    if (record !== '') {
      applyEdgeRow(graph, parseRow(record), edgeCols);
    }
  }

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

export const csvCodec: Codec = { name: 'csv', encode, decode, encodeStream, decodeStream };
