//! Item 2542: this module had NO tests anywhere — not in the file, not in a sibling `tests.rs`,
//! and zero mentions in `CLOSED.md`. It is 92 lines that hand-roll **JSON string escaping** for the
//! C ABI's last-error channel, which is the ENCODER counterpart to the decoder escaping audited at
//! items 2533 and 2535.
//!
//! ## The oracle, and why it compares VALUES rather than BYTES
//!
//! `serde_json` is an independent implementation of the same RFC, so it can say whether a report is
//! valid JSON and what it decodes to. It must NOT be used for byte-identity: this escaper sends
//! `0x08` and `0x0c` through its `< 0x20` arm as `\u0008` / `\u000c` where serde writes `\b` / `\f`.
//! Both are valid and both decode to the same character, so the contract is **"valid JSON that
//! decodes back to the original message"**, not "the same bytes serde would emit". Asserting bytes
//! would fail on correct code.
//!
//! The three rows below also test the module's own docstring claims (rule xiv): that `begin()`
//! clears the slot, that reading TAKES it so one failure is never reported twice, and that the
//! report carries the caller's `code` and `message`.

use super::{begin, lnk_last_error_json, set};

/// Read the pending report the way the host does, through the real C entry point.
fn take_report() -> Option<String> {
    let mut len: usize = 0;
    // SAFETY: `len` is a live, writable `usize`, which is the function's whole contract.
    let ptr = unsafe { lnk_last_error_json(&raw mut len) };

    if ptr.is_null() {
        return None;
    }

    // SAFETY: the pointer came from `Box<[u8]>::into_raw` with exactly `len` bytes, so this
    // reconstitutes the same allocation and frees it on drop — the test's stand-in for `lnk_free`.
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };

    Some(String::from_utf8(bytes).expect("the report is UTF-8"))
}

#[test]
fn every_escaped_message_is_valid_json_that_decodes_back() {
    // Each is a MESSAGE that must survive the escaper intact.
    let mut cases: Vec<String> = vec![
        "plain".to_string(),
        "a \"quoted\" word".to_string(),
        "a back\\slash".to_string(),
        "two\nlines".to_string(),
        "tab\there".to_string(),
        "carriage\rreturn".to_string(),
        "é accented".to_string(),
        "中文".to_string(),
        "\u{1F600} astral".to_string(),
        "mixed \"q\" \\ \n \t end".to_string(),
        String::new(),
    ];

    // EVERY control character, including 0x08 and 0x0c, which take the `< 0x20` arm rather than
    // serde's `\b` / `\f` shorthand — the reason this test compares decoded values.
    for c in 0u32..0x20 {
        cases.push(format!("ctrl<{}>", char::from_u32(c).expect("in range")));
    }

    for message in &cases {
        begin();
        set("E_FFI", message);

        let report = take_report().expect("a report was recorded");
        let parsed: serde_json::Value = serde_json::from_str(&report).unwrap_or_else(|e| {
            panic!("the report for {message:?} is not valid JSON: {e}\n  report: {report}")
        });

        assert_eq!(
            parsed["message"].as_str(),
            Some(message.as_str()),
            "the message did not survive escaping",
        );
        assert_eq!(parsed["code"].as_str(), Some("E_FFI"));
        assert!(parsed["details"].is_null(), "details is always null today");
    }
}

/// The docstring's "take on read" claim: one failure is never reported twice.
#[test]
fn reading_the_report_takes_it() {
    begin();
    set("E_FFI", "boom");

    assert!(take_report().is_some(), "the first read returns the report");
    assert!(
        take_report().is_none(),
        "the second read must return null — a report read twice could be paired with a later \
         null return from an unrelated call",
    );
}

/// The docstring's other claim: `begin()` clears, so a stale report can never be paired with a
/// later `null`. Without it, a call that fails and a LATER call that fails for no recorded reason
/// would both report the first failure.
#[test]
fn begin_clears_a_stale_report() {
    begin();
    set("E_FIRST", "first failure");
    begin();

    assert!(
        take_report().is_none(),
        "begin() must clear, or a stale report outlives the call that produced it",
    );

    // And the slot works again afterwards — a clear that broke recording would also pass the
    // assertion above.
    set("E_SECOND", "second failure");

    let report = take_report().expect("recording still works after a clear");

    assert!(report.contains("E_SECOND"), "got: {report}");
    assert!(
        !report.contains("E_FIRST"),
        "the stale code came back: {report}"
    );
}

/// NOT ESCAPED, and recorded deliberately: `set` pushes `code` raw.
///
/// Every call site passes a fixed slug (`E_FFI`, `E_UNIMPLEMENTED`, `E_CONSTRAINT`, …), so today no
/// caller can corrupt the report — but that is safe by REACHABILITY, not by construction, and this
/// repo prefers the latter. This row pins the status quo so a future caller that threads a dynamic
/// string into `code` fails here instead of silently emitting malformed JSON to the host.
#[test]
fn the_code_slug_is_not_escaped_which_is_why_it_must_stay_a_fixed_slug() {
    begin();
    set("E_\"BROKEN", "ordinary message");

    let report = take_report().expect("a report was recorded");

    assert!(
        serde_json::from_str::<serde_json::Value>(&report).is_err(),
        "a quote in `code` currently produces malformed JSON; if this now PARSES, `code` has been \
         given escaping and this test should assert the round trip instead: {report}",
    );
}
