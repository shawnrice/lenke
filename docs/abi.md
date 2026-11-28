# The engine C ABI (`lnk_*`)

The Rust engine's foreign-function surface: a deliberately small, flat set of **16 exported
symbols** that `packages/native` loads as its Rust backend (bun:ffi) and that the wasm build
exposes to the CLI.

Three source files reference this document — `crates/lenke-engine/src/ffi.rs`,
`crates/lenke-engine/src/schema_op.rs` and `packages/native/src/backend-engine.ts`. It did not
exist until item 2544 noticed the dangling references; everything below is **measured** from the
behaviour pinned by items 2542–2544 rather than described from intent, and
`crates/lenke-engine/src/ffi/tests.rs` embeds this file so deleting it breaks the build.

## The shape of every call

- The ABI is gated behind the **`capi` cargo feature**, so a plain `cargo build`/`cargo test`
  exports none of these symbols. CI runs a dedicated `--features capi` step for tests and clippy
  (added at item 2542, after ~1,360 lines of this surface turned out to be outside both gates).
- A handle is an opaque `*mut Store` from `lnk_open` or `lnk_clone`, released with `lnk_close`.
- **Fallible calls keep their return for data and report errors out of band.** The data return is
  never an error union, so a binary carrier (Arrow) rides its own channel unaffected.
- Every fallible entry calls `begin()` on entry, which **clears** any prior report, so a `null` /
  `-1` return can never be paired with a stale error from an earlier call.
- `lnk_last_error_json(out_len)` retrieves **and clears** the calling thread's last report as
  `{"code","message","details"}`. Reading **takes** it: one failure is never reported twice.
- A buffer the engine returns is freed with `lnk_free(ptr, len)`. Host-owned input memory (the wasm
  path) is `lnk_alloc` / `lnk_dealloc`.

### Passing null

Every pointer-taking entry **checks for null** and answers with its sentinel — null is defined
behaviour here, not undefined. A _dangling_ or garbage pointer is undefined behaviour and the
engine cannot defend against it; that is the caller's half of the contract.

## The 16 symbols

| symbol                                                    | returns      | on failure                               |
| --------------------------------------------------------- | ------------ | ---------------------------------------- |
| `lnk_abi_version()`                                       | `u32`        | infallible                               |
| `lnk_alloc(len)`                                          | `*mut u8`    | host-owned scratch; see the note below   |
| `lnk_dealloc(ptr, len)`                                   | —            | releases `lnk_alloc` memory              |
| `lnk_free(ptr, len)`                                      | —            | releases an engine-returned buffer       |
| `lnk_open(ptr, len, format, threads)`                     | `*mut Store` | `null` + report                          |
| `lnk_clone(s)`                                            | `*mut Store` | `null` + report                          |
| `lnk_close(s)`                                            | —            | null-safe                                |
| `lnk_config(s, id, value)`                                | `u32`        | **`1` applied, `0` refused** (see below) |
| `lnk_stat(s, which)`                                      | `u64`        | `0`, and **no report** (see below)       |
| `lnk_query(s, lang, q, q_len, p, p_len, format, out_len)` | `*mut u8`    | `null` + report                          |
| `lnk_tx(s, action)`                                       | `i32`        | `0` ok, `-1` + report                    |
| `lnk_schema_apply(s, json, json_len)`                     | `i32`        | `0` ok, `-1` + report                    |
| `lnk_schema_dump(s, out_len)`                             | `*mut u8`    | `null` + report                          |
| `lnk_encode(s, format, out_len)`                          | `*mut u8`    | `null` + report                          |
| `lnk_command(s, name, name_len, in, in_len, out_len)`     | `*mut u8`    | `null` + report                          |
| `lnk_last_error_json(out_len)`                            | `*mut u8`    | `null` when nothing is pending           |

### Discriminants

| parameter            | values                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| `lnk_open` `format`  | `0` NDJSON (a null `ptr` opens an empty graph), plus the other decoders      |
| `lnk_query` `lang`   | `0` GQL, `1` Gremlin                                                         |
| `lnk_query` `format` | `0` JSON rows, `1` Arrow, `2` Arrow IPC                                      |
| `lnk_tx` `action`    | `0` begin, `1` commit, `2` rollback                                          |
| `lnk_stat` `which`   | `0` vertex count, `1` edge count, `2` version (a monotonic mutation counter) |

An out-of-range discriminant returns the entry's sentinel **and records a report** — it is never
silently treated as a default.

### Two entries whose contract differs, deliberately

**`lnk_config` is boolean, not errno.** It returns **`1` when the limit was applied** and **`0`** for
a null handle, an unknown setting id, or a zero value (a zero ceiling is refused, matching the TS
engine). Reading `0` as success is the natural errno habit and it is wrong here.

**`lnk_stat` has no error channel.** A null handle and an unknown selector both read `0`, which is
also a legitimate answer — an empty graph has 0 nodes. That is deliberate for an infallible getter
with no sentinel to spare, so `0` is ambiguous by construction and `lnk_stat` records nothing.

**`lnk_alloc` aborts rather than returning null on allocation failure**, because it uses Rust's
`Vec::with_capacity`. A C allocator would hand back `NULL` and let the host recover. This is a known
open question rather than settled behaviour.

## `lnk_command` — the named-operation channel

A command takes a UTF-8 **name** plus a command-specific payload, so a new operation fills an arm
rather than exporting a new symbol. **Seven names are implemented:**

| name               | payload                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `last_write_scope` | the scope-key property name; returns `{"scopes":[…],"open":bool}` |
| `merge`            | NDJSON text; first-wins bulk merge, returns a `MergeReport`       |
| `epoch`            | the token name                                                    |
| `prepare`          | `{query, maxDepth?}`                                              |
| `prepared_run`     | `{handle, params}`                                                |
| `prepared_free`    | `{handle}`                                                        |
| `algo`             | `{name, config}`                                                  |

**Reading the two failure codes apart matters:**

- a name that exists but was handed the wrong payload reports **`E_FFI`**, naming the payload it
  wants;
- a name the engine does not know reports **`E_NOT_IMPLEMENTED`**, echoing the name so the host can
  log it.

So `E_NOT_IMPLEMENTED` means _this engine is older than your client_, while `E_FFI` means _you
called it wrong_. There is no binary-snapshot command; the binary format is reached through
`lnk_encode`'s format discriminant.

## `lnk_schema_apply` — the schema-DDL vocabulary

One tagged JSON object per call selects the operation. `on` selects the target and is **required** —
a missing `on` is rejected with `missing field `on``, not defaulted to `vertex`. (Item 2545 wrote
"defaults to `vertex`" here, copied from this module's own docstring; item 2546 measured both wrong
and corrected the docstring too.) `cardinality` names its edge type `edgeType`, not `etype`, and
requires `min`.

```jsonc
{ "op": "createIndex", "on": "vertex", "kind": "hash",     "keys": ["age"] }
{ "op": "createIndex", "on": "vertex", "kind": "range",    "keys": ["score"] }
{ "op": "createIndex", "on": "edge",   "kind": "interval", "keys": ["lo", "hi"] }
{ "op": "createIndex", "on": "edge",   "kind": "type" }
{ "op": "dropIndex",   "on": "vertex", "kind": "hash",     "keys": ["age"] }
{ "op": "unique",      "on": "vertex", "label": "Person",  "key": "email" }
{ "op": "required",    "on": "vertex", "label": "Person",  "key": "name" }
{ "op": "cardinality", "label": "Person", "edgeType": "KNOWS", "direction": "out", "min": 0, "max": 5 }
{ "op": "invariant",   "name": "…", "source": "…" }
```

Each of these is rejected with a coded `BadRequest` rather than ignored: an unknown `op`, an unknown
`on` target, an index whose `on`/`kind` pair is unsupported, a `cardinality` `direction` that is not
`"out"` or `"in"`, a field that must be numeric and is not, and an index needing exactly one key
given a different number.

## Error codes

Reports carry a code from the shared `@lenke/errors` vocabulary, so a host maps them to the same
`LenkeError` the TypeScript engine raises — `E_SYNTAX`, `E_CONSTRAINT_VIOLATION`, `E_INVALID_VALUE`,
`E_UNSUPPORTED`, `E_INVALID_JSON`, `E_MISSING_VERTEX`, `E_INVALID_GRAPH_OP`, and the two ABI-local
ones above (`E_FFI`, `E_NOT_IMPLEMENTED`).

The `code` field of a report is **not** JSON-escaped: every caller passes a fixed slug, so a dynamic
`code` containing a quote would emit malformed JSON. A test pins the current behaviour so that a
future dynamic `code` fails loudly rather than reaching the host broken.
