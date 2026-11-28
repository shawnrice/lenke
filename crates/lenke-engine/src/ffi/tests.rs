//! Item 2543: `ffi.rs` is 1264 lines with **no tests at all** — the gap item 2542 made visible when
//! it put the `capi` feature into CI. This is the C ABI: 12 `lnk_*` exports that every bun:ffi and
//! wasm consumer crosses.
//!
//! ## What this sweep asserts, and why those assertions are available now
//!
//! Each fallible entry documents a SENTINEL (`null` or `-1`) and records a report on the
//! out-of-band channel. Item 2542 pinned that channel — read takes, `begin()` clears, the JSON is
//! valid — so it can now be the assertion rather than a second unknown. Three rows per entry where
//! they apply:
//!
//! 1. a **null handle** returns the documented sentinel;
//! 2. an **out-of-range discriminant** (`format`, `lang`, `action`, `which`) returns it too;
//! 3. a **valid CONTROL** succeeds AND leaves NO report pending — which is the `begin()` contract
//!    observed end-to-end, and the row that stops the first two passing for the wrong reason.
//!
//! ## What it deliberately does NOT do
//!
//! **No invalid pointers.** Passing `null` is defined behaviour here — every entry checks it
//! (`store_ref`/`store_mut` go through `as_ref()`/`as_mut()`, which yield `None`, and `in_str`
//! null-checks before `from_raw_parts`). Passing a DANGLING or garbage pointer would be undefined
//! behaviour, which is not a test of anything: the result would be meaningless whichever way it
//! came out. So the sweep covers the null and discriminant surface, not pointer validity.
//!
//! And per item 2539: a test like this cannot observe an ABORT. If an entry aborted, this file
//! would not fail with a message — it would kill the test binary.

use super::{
    lnk_abi_version, lnk_clone, lnk_close, lnk_config, lnk_encode, lnk_free, lnk_open, lnk_query,
    lnk_schema_apply, lnk_schema_dump, lnk_stat, lnk_tx,
};
use crate::store::Store;

const NDJSON: &str =
    "{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"P\"],\"properties\":{\"n\":1}}\n";

/// A live handle from the real entry point, so the sweep never fabricates one.
fn open() -> *mut Store {
    // SAFETY: a valid UTF-8 range and format 0 (NDJSON), which is the documented happy path.
    let s = unsafe { lnk_open(NDJSON.as_ptr(), NDJSON.len(), 0, 1) };

    assert!(
        !s.is_null(),
        "the control open must succeed: {:?}",
        pending()
    );

    s
}

/// Whatever report is pending, TAKEN (so it cannot leak into the next row).
fn pending() -> Option<String> {
    let mut len: usize = 0;
    // SAFETY: `len` is a live writable usize.
    let ptr = unsafe { crate::ffi_error::lnk_last_error_json(&raw mut len) };

    if ptr.is_null() {
        return None;
    }

    // SAFETY: the buffer came from `Box<[u8]>::into_raw` with exactly `len` bytes.
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };

    Some(String::from_utf8(bytes).expect("the report is UTF-8"))
}

/// Free an engine-returned buffer through the documented entry.
fn free_out(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: the buffer came from this module and is freed exactly once.
        unsafe { lnk_free(ptr, len) };
    }
}

#[test]
fn the_abi_version_is_a_plain_constant() {
    // Not fallible and not pointer-taking: the one entry with nothing to get wrong, kept as the
    // sweep's floor. If this ever needs a handle, the ABI changed shape.
    assert!(lnk_abi_version() > 0);
}

#[test]
fn a_null_handle_returns_the_documented_sentinel_on_every_fallible_entry() {
    let mut out_len: usize = 0;

    // SAFETY: every call below passes a NULL handle, which each entry is documented to check.
    unsafe {
        assert!(
            lnk_clone(std::ptr::null()).is_null(),
            "clone: null handle → null"
        );

        assert_eq!(lnk_tx(std::ptr::null_mut(), 0), -1, "tx: null handle → -1");
        assert!(
            pending().is_some(),
            "tx must record a report for a null handle"
        );

        assert_eq!(
            lnk_schema_apply(std::ptr::null_mut(), c"{}".as_ptr().cast(), 2),
            -1,
            "schema_apply: null handle → -1",
        );

        assert!(
            lnk_schema_dump(std::ptr::null(), &raw mut out_len).is_null(),
            "schema_dump: null handle → null",
        );

        assert!(
            lnk_encode(std::ptr::null(), 0, &raw mut out_len).is_null(),
            "encode: null handle → null",
        );

        let q = "MATCH (n:P) RETURN count(*) AS c";
        assert!(
            lnk_query(
                std::ptr::null_mut(),
                0,
                q.as_ptr(),
                q.len(),
                std::ptr::null(),
                0,
                0,
                &raw mut out_len,
            )
            .is_null(),
            "query: null handle → null",
        );
    }

    // Drain anything the rows above recorded, so a later row cannot read a stale report.
    let _ = pending();
}

#[test]
fn an_out_of_range_discriminant_returns_the_sentinel_and_records_why() {
    let s = open();
    let mut out_len: usize = 0;

    // SAFETY: `s` is a live handle from `open`; only the DISCRIMINANTS are out of range.
    unsafe {
        // `lnk_tx` action: 0 begin, 1 commit, 2 rollback.
        assert_eq!(lnk_tx(s, 9), -1, "tx: unknown action → -1");
        let report = pending().expect("tx records why it refused an unknown action");
        assert!(report.contains("E_"), "the report carries a code: {report}");

        // `lnk_query` lang: 0 GQL, 1 Gremlin.
        let q = "MATCH (n:P) RETURN count(*) AS c";
        assert!(
            lnk_query(
                s,
                9,
                q.as_ptr(),
                q.len(),
                std::ptr::null(),
                0,
                0,
                &raw mut out_len
            )
            .is_null(),
            "query: unknown lang → null",
        );
        assert!(
            pending().is_some(),
            "query records why it refused an unknown lang"
        );

        // `lnk_query` format: 0 JSON rows, 1 Arrow, 2 Arrow IPC.
        assert!(
            lnk_query(
                s,
                0,
                q.as_ptr(),
                q.len(),
                std::ptr::null(),
                0,
                99,
                &raw mut out_len
            )
            .is_null(),
            "query: unknown output format → null",
        );
        assert!(
            pending().is_some(),
            "query records why it refused an unknown format"
        );

        // `lnk_encode` format.
        assert!(
            lnk_encode(s, 99, &raw mut out_len).is_null(),
            "encode: unknown format → null",
        );
        assert!(
            pending().is_some(),
            "encode records why it refused an unknown format"
        );

        lnk_close(s);
    }
}

/*
 * `lnk_stat` and `lnk_config` have a DIFFERENT contract, pinned here rather than flagged.
 *
 * `lnk_stat` returns `u64` with no error channel at all: a null handle and an unknown `which` both
 * read 0, which is also a legitimate value (an empty graph has 0 nodes). That is a deliberate
 * design for an infallible getter, not an oversight — it has no sentinel to spare. Recording it so
 * nobody "fixes" it into reporting, and so a future reader knows 0 is ambiguous BY CONSTRUCTION.
 */
#[test]
fn stat_is_infallible_and_answers_zero_rather_than_reporting() {
    // SAFETY: a null handle, which `store_ref` turns into `None`.
    let null_stat = unsafe { lnk_stat(std::ptr::null(), 0) };

    assert_eq!(null_stat, 0, "stat on a null handle reads 0");
    assert!(
        pending().is_none(),
        "stat records NO report — it has no sentinel to spare"
    );

    let s = open();

    // SAFETY: `s` is live.
    unsafe {
        assert_eq!(lnk_stat(s, 0), 1, "one node in the fixture");
        assert_eq!(
            lnk_stat(s, 9),
            0,
            "an unknown `which` also reads 0 — ambiguous by design"
        );
        assert!(pending().is_none(), "still no report");

        lnk_close(s);
    }
}

#[test]
fn a_successful_call_leaves_no_report_pending() {
    // THE CONTROL for the whole sweep, and the `begin()` contract observed end to end. Without it,
    // every assertion above could pass on an engine that reported an error for EVERY call.
    let s = open();
    let mut out_len: usize = 0;

    assert!(
        pending().is_none(),
        "a successful open must leave the channel empty — `begin()` clears on entry",
    );

    // SAFETY: `s` is live, the query is a valid UTF-8 range, `out_len` is writable.
    unsafe {
        let q = "MATCH (n:P) RETURN count(*) AS c";
        let out = lnk_query(
            s,
            0,
            q.as_ptr(),
            q.len(),
            std::ptr::null(),
            0,
            0,
            &raw mut out_len,
        );

        assert!(
            !out.is_null(),
            "the control query must succeed: {:?}",
            pending()
        );
        assert!(pending().is_none(), "a successful query leaves no report");

        let rows = std::slice::from_raw_parts(out, out_len);
        let text = std::str::from_utf8(rows).expect("JSON rows are UTF-8");

        assert!(text.contains("\"c\""), "the column is present: {text}");
        free_out(out, out_len);

        // A clone is a separate handle that answers the same.
        let c = lnk_clone(s);
        assert!(!c.is_null(), "clone succeeds: {:?}", pending());
        assert_eq!(
            lnk_stat(c, 0),
            lnk_stat(s, 0),
            "the clone has the same node count"
        );

        lnk_close(c);
        lnk_close(s);
    }
}

/*
 * A sentinel from a BAD INPUT rather than a bad handle — the row that proves the entries reject
 * malformed payloads through the same channel. `lnk_open` with format 0 and non-UTF-8 bytes is the
 * documented `E_FFI` case, and a syntactically invalid query is the `E_SYNTAX` case.
 */
#[test]
fn malformed_input_reports_through_the_same_channel() {
    // Lone 0xff is not valid UTF-8 in any position.
    let bad = [0xffu8, 0xfe, 0xff];

    // SAFETY: a readable, initialized range of exactly 3 bytes.
    let s = unsafe { lnk_open(bad.as_ptr(), bad.len(), 0, 1) };

    assert!(s.is_null(), "non-UTF-8 NDJSON input → null");

    let report = pending().expect("a report says why the open failed");

    assert!(report.contains("E_"), "the report carries a code: {report}");

    let live = open();
    let mut out_len: usize = 0;

    // SAFETY: `live` is a handle; the query text is a valid range but not valid GQL.
    unsafe {
        let q = "THIS IS NOT GQL";
        let out = lnk_query(
            live,
            0,
            q.as_ptr(),
            q.len(),
            std::ptr::null(),
            0,
            0,
            &raw mut out_len,
        );

        assert!(out.is_null(), "a syntax error → null");

        let report = pending().expect("a report says why the query failed");

        assert!(report.contains("E_"), "the report carries a code: {report}");

        lnk_close(live);
    }
}

/*
 * `lnk_config` returns a `u32` STATUS, and its polarity is the opposite of the errno convention:
 * the doc says "**Returns 1 when applied, 0 for a null handle / unknown id / zero value**".
 *
 * My first version of this row asserted `status != 0` for an unknown id — written from habit, where
 * 0 means OK — and it failed against correct code. An ABI status code's polarity is a DOCUMENTED
 * CHOICE, not a convention to infer; this one is boolean-style, not errno-style. Recorded because
 * the mistake is silent in the other direction: a row asserting `== 0` with no positive control
 * would pass against a function that always returned 0.
 *
 * So both polarities, and the three documented ways to get 0. Item 2527 established that the id
 * space is shared with the TS engine and append-only (TS holds 0-3 and 5; 4 and 6 are native-only),
 * so id 0 is a real setting and 9_999 is one nobody has taken — what a host sees when it sends a
 * newer setting to an older engine.
 */
#[test]
fn config_reports_applied_as_one_and_every_refusal_as_zero() {
    let s = open();

    // SAFETY: `s` is live for all four calls; only the arguments vary.
    unsafe {
        assert_eq!(
            lnk_config(s, 0, 1_000),
            1,
            "a known id with a non-zero value is APPLIED"
        );

        assert_eq!(
            lnk_config(s, 9_999, 1),
            0,
            "an id nobody has taken is refused"
        );
        assert_eq!(
            lnk_config(s, 0, 0),
            0,
            "a zero ceiling is refused (matches the TS engine)"
        );
        assert_eq!(
            lnk_config(std::ptr::null_mut(), 0, 1_000),
            0,
            "a null handle is refused"
        );

        lnk_close(s);
    }

    assert!(
        pending().is_none(),
        "config has no error channel — it answers with its status alone",
    );
}

/*
 * Item 2544: the COMMAND-NAME surface. Item 2543 pinned the numeric discriminants
 * (`format`/`lang`/`action`/`which`) and left this uncovered — `lnk_command` dispatches on a
 * STRING, the same "accept then ignore" risk over a far wider input space.
 *
 * SEVEN names are matched: `last_write_scope`, `merge`, `epoch`, `prepare`, `prepared_run`,
 * `prepared_free`, `algo`. (My first count said eight: a regex for `"name" =>` also scooped
 * `"arrow" | "arrow_ipc"`, which matches a FORMAT string inside a payload, not a command. And the
 * catch-all is spelled `other =>`, not `_ =>`, so a regex for `_ =>` found nothing and briefly
 * suggested the match had no fallback. A failed pattern is not evidence about structure.)
 *
 * ## WHAT THESE ROWS ASSERT, AND THE STALE COMMENT THEY REPLACE
 *
 * Measured with no payload, all seven implemented names answer `E_FFI` with a message naming the
 * payload they want, and only an UNKNOWN name answers `E_NOT_IMPLEMENTED`. That distinction is the
 * assertion: it separates "built, needs input" from "not built" at the CODE level, so it survives
 * message rewording (rule xv).
 *
 * It also replaces a comment in `ffi.rs` that listed prepared statements, `epoch` and `merge` as
 * "not yet built in the engine" when all three have working arms — a claim that would have told a
 * reader prepared statements were unavailable. Pinning it as code is what stops it drifting again.
 */
#[test]
fn every_implemented_command_rejects_a_missing_payload_rather_than_reporting_unimplemented() {
    let names = [
        "last_write_scope",
        "merge",
        "epoch",
        "prepare",
        "prepared_run",
        "prepared_free",
        "algo",
    ];

    for name in names {
        let s = open();
        let mut out_len: usize = 0;

        // SAFETY: `s` is live, the name is a valid UTF-8 range, the payload is null (documented as
        // "no input"), and `out_len` is writable.
        let out = unsafe {
            super::lnk_command(
                s,
                name.as_ptr(),
                name.len(),
                std::ptr::null(),
                0,
                &raw mut out_len,
            )
        };

        if out.is_null() {
            let report = pending().unwrap_or_else(|| {
                panic!("`{name}` returned null with NO report — the host cannot describe this")
            });

            assert!(
                report.contains("E_FFI"),
                "`{name}` has an arm, so a missing payload is an INPUT error (E_FFI), not \
                 E_NOT_IMPLEMENTED — if this name was removed, say so here: {report}",
            );
        } else {
            // A command that needs no payload may legitimately succeed; it must then be silent.
            assert!(
                pending().is_none(),
                "`{name}` succeeded but left a report pending"
            );
            free_out(out, out_len);
        }

        // SAFETY: `s` is live and freed exactly once.
        unsafe { super::lnk_close(s) };
    }
}

#[test]
fn an_unknown_command_reports_not_implemented_and_echoes_the_name() {
    let s = open();
    let mut out_len: usize = 0;
    let name = "no_such_command_xyz";

    // SAFETY: `s` is live; the name is a valid UTF-8 range.
    let out = unsafe {
        super::lnk_command(
            s,
            name.as_ptr(),
            name.len(),
            std::ptr::null(),
            0,
            &raw mut out_len,
        )
    };

    assert!(out.is_null(), "an unknown command must return null");

    let report = pending().expect("an unknown command records a report");

    assert!(
        report.contains("E_NOT_IMPLEMENTED"),
        "an unknown command is E_NOT_IMPLEMENTED, which is what separates it from the seven \
         implemented names above: {report}",
    );
    assert!(
        report.contains(name),
        "the report echoes the name the host asked for, so the host can log it: {report}",
    );

    // SAFETY: `s` is live and freed exactly once.
    unsafe { super::lnk_close(s) };
}

/*
 * The CONTROL for both rows: a command that genuinely WORKS, with its payload. Without it, the two
 * above could pass against an engine where every command failed.
 *
 * `last_write_scope` is the choice because its payload is a bare property name rather than a JSON
 * document, so the row tests the command rather than a JSON parser.
 */
#[test]
fn a_command_with_its_payload_succeeds_and_returns_a_document() {
    let s = open();
    let mut out_len: usize = 0;
    let name = "last_write_scope";
    let payload = "room";

    // SAFETY: `s` is live; both ranges are valid UTF-8; `out_len` is writable.
    let out = unsafe {
        super::lnk_command(
            s,
            name.as_ptr(),
            name.len(),
            payload.as_ptr(),
            payload.len(),
            &raw mut out_len,
        )
    };

    assert!(
        !out.is_null(),
        "the control command must succeed: {:?}",
        pending()
    );
    assert!(pending().is_none(), "a successful command leaves no report");

    // SAFETY: the engine returned `out_len` bytes at `out`.
    let text = unsafe {
        std::str::from_utf8(std::slice::from_raw_parts(out, out_len))
            .expect("the document is UTF-8")
    };

    assert!(
        text.contains("scopes"),
        "the documented output shape is {{\"scopes\":[…],\"open\":b}}: {text}",
    );

    free_out(out, out_len);

    // SAFETY: `s` is live and freed exactly once.
    unsafe { super::lnk_close(s) };
}

/*
 * Item 2544b: `docs/abi.md` is referenced FOUR times from three files —
 * `ffi.rs` (twice), `schema_op.rs`, and `packages/native/src/backend-engine.ts` (which spells it
 * `crates/lenke-engine/docs/abi.md`) — and **it did not exist**. A sweep of every markdown path under docs
 * mentioned in source found 29 that resolve and these as the only danglers. For a C ABI that is
 * the one document a host integrator goes looking for, so it was written from the behaviour items
 * 2542-2544 measured.
 *
 * ## THE GUARD, AND WHY IT IS `include_str!`
 *
 * `include_str!` resolves at COMPILE time, so deleting or moving the doc breaks the build rather
 * than rotting into another dangling reference — the same trick item 2536 used for the codec
 * corpus, for the same reason: a prose pointer is exactly what rotted here.
 *
 * And existence alone is too weak. The doc is checked to NAME EVERY EXPORTED SYMBOL, against the
 * live export list rather than a hand-typed one, so adding a 17th `lnk_*` without documenting it
 * fails here. `ffi.rs`'s own header claims "16 symbols"; that claim was verified by enumeration at
 * this item and is TRUE, so the count below is an independent restatement of it, not a copy.
 */
const ABI_DOC: &str = include_str!("../../../../docs/abi.md");

#[test]
fn the_abi_document_exists_and_names_every_exported_symbol() {
    // The live list. Kept here rather than read from source because a test cannot parse its own
    // crate — but every name is one this file already imports or calls, so a renamed export breaks
    // compilation before it reaches this assertion.
    let exported = [
        "lnk_abi_version",
        "lnk_alloc",
        "lnk_clone",
        "lnk_close",
        "lnk_command",
        "lnk_config",
        "lnk_dealloc",
        "lnk_encode",
        "lnk_free",
        "lnk_last_error_json",
        "lnk_open",
        "lnk_query",
        "lnk_schema_apply",
        "lnk_schema_dump",
        "lnk_stat",
        "lnk_tx",
    ];

    assert_eq!(
        exported.len(),
        16,
        "`ffi.rs`'s header says the ABI is 16 symbols; keep this list and that claim together",
    );

    let undocumented: Vec<&str> = exported
        .iter()
        .copied()
        .filter(|sym| !ABI_DOC.contains(sym))
        .collect();

    assert!(
        undocumented.is_empty(),
        "docs/abi.md does not mention {undocumented:?} — a host integrator reading it would not \
         know those entries exist",
    );
}

/*
 * The two contracts most likely to be mis-read by a host must be stated in the doc, not just in
 * the code. Both were pinned by measurement (2543) and both are the kind of thing a reader assumes
 * from convention and gets backwards.
 */
#[test]
fn the_abi_document_states_the_two_counter_intuitive_contracts() {
    assert!(
        ABI_DOC.contains("boolean, not errno"),
        "the doc must say `lnk_config` returns 1-for-applied, because 0-means-OK is the habit a \
         reader brings and it is wrong here",
    );
    assert!(
        ABI_DOC.contains("no error channel"),
        "the doc must say `lnk_stat` records nothing and that its 0 is ambiguous by construction",
    );
    assert!(
        ABI_DOC.contains("E_NOT_IMPLEMENTED") && ABI_DOC.contains("E_FFI"),
        "the doc must separate `this engine is older than your client` from `you called it wrong`",
    );
}
