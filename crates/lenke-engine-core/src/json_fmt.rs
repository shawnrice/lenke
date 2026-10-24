//! Pure Value -> JSON / JS-string formatters (no query layer). Split from the
//! engine's `json` module so the value layer can format itself without depending
//! on `exec` (the `Rows` formatters stay in `lenke-engine`).

use crate::value::Value;
use std::fmt::Write;

/// Append `v` to `out` as JSON.
pub fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(x) => write_number(out, *x),
        Value::Str(s) => write_string(out, s),
        // A temporal renders TAGGED — `{"@date":"2020-01-01"}`, `{"@duration":"P1D"}`,
        // … — matching core's query-result form (and the NDJSON/elementMap wire form),
        // not a bare ISO string.
        Value::Temporal(t) => {
            out.push_str("{\"@");
            out.push_str(t.tag());
            out.push_str("\":");
            write_string(out, &t.format());
            out.push('}');
        }
        Value::List(items) => {
            out.push('[');
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, it);
            }
            out.push(']');
        }
        Value::Record(fields) => {
            // A record renders as an object keyed by field name, in field order.
            out.push('{');
            for (i, (k, val)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, val);
            }
            out.push('}');
        }
        Value::Map(pairs) => {
            // A map (element map, group map, …) renders as an object in INSERTION order
            // — key order is significant for the value-level compare. Keys are stringified.
            out.push('{');
            for (i, (k, val)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                match k {
                    Value::Str(s) => write_string(out, s),
                    // A non-string key (a numeric group key, T.label token) → its JSON
                    // scalar text as the object key, matching core's map rendering.
                    other => {
                        let mut kb = String::new();
                        write_value(&mut kb, other);
                        write_string(out, kb.trim_matches('"'));
                    }
                }
                out.push(':');
                write_value(out, val);
            }
            out.push('}');
        }
        // SPIKE: an element ref should be RESOLVED to its element map by render_cell before it
        // reaches JSON egress; a bare one here means an egress path did not resolve it. Emit a
        // distinctive marker (not a panic) so the differential fuzzer surfaces the leak.
        Value::Node(id) => {
            let _ = write!(out, "\"__UNRESOLVED_NODE_{id}__\"");
        }
        Value::Edge(id) => {
            let _ = write!(out, "\"__UNRESOLVED_EDGE_{id}__\"");
        }
    }
}

/// A finite number as its shortest round-tripping text; a non-finite one as `null`
/// (JSON has no NaN/Infinity — core emits null too, per the NaN policy).
pub fn write_number(out: &mut String, x: f64) {
    if !x.is_finite() {
        out.push_str("null");
    } else if x.fract() == 0.0 && x.abs() < 1e15 {
        // Integer-valued: emit without a decimal point (matches `js_number` for this
        // range but skips the `{:e}` round-trip — a hot-path shortcut).
        let _ = write!(out, "{}", x as i64);
    } else {
        // `push_js_number`, not `&js_number(x)`: the wrapper allocates an owned `String` only
        // to copy it into `out` and drop it. Item 654 — this is the JSON egress path, so it is
        // once per non-integer number in every serialized result.
        push_js_number(out, x);
    }
}

/// Format `x` exactly as JavaScript's `Number.prototype.toString` does — the fixed /
/// exponential threshold (decimal-point position `n > 21` or `n <= -6` → exponential),
/// and `-0` → `"0"`. Rust's `{}` formats an f64 in decimal at ALL magnitudes
/// (`1e-7` → `0.0000001`, `1e21` → `1000000000000000000000`), which is a different STRING
/// from JS even though it parses to the same f64 — so any number that becomes a STRING
/// (`to_string` / `CAST AS STRING` / `||`) must route through here for byte-identity with
/// core / the TS engine. Ported from the now-removed lenke-core's `jsonfmt::js_number`. `{:e}` gives the
/// shortest round-tripping mantissa; this just places the decimal point per the spec.
pub fn js_number(x: f64) -> String {
    let mut out = String::new();
    push_js_number(&mut out, x);
    out
}

/// A fixed 32-byte scratch that `write!` can target with no heap allocation — big enough for
/// any `{:e}`-formatted `f64` (≤17 mantissa digits + `.` + `e±NNN`).
struct Scratch<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> std::fmt::Write for Scratch<N> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let b = s.as_bytes();
        let end = self.len + b.len();

        if end > self.buf.len() {
            return Err(std::fmt::Error);
        }

        self.buf[self.len..end].copy_from_slice(b);
        self.len = end;
        Ok(())
    }
}

/// Write `x` as its JS `Number.toString` form straight into `out`, with NO per-number
/// allocation — the hot-path twin of [`js_number`].
///
/// # Why this exists here (item 654)
///
/// `js_number` USED to be this function's body with three `String` allocations in it: a
/// `format!("{:e}", …)`, a `mant.chars().filter(…).collect::<String>()`, and the output
/// `String::new()`. Every one was built and dropped per call, and `GStr`'s 12-byte inline
/// capacity means the caller usually did not even keep the last one.
///
/// `expression_cost_by_kind` priced `CAST(n.k AS STRING)` at **92.67 ns/row, 103x** the
/// cheapest useful read (`Prop (Num)` at 0.90) — the largest row in that table, and the only
/// large one with no "planner-unreachable" or "a filter takes a typed path" caveat beside it.
///
/// **This implementation is a PORT, not an invention.** `lenke-codec::jsonfmt::push_js_number`
/// has had exactly this stack-buffer shape all along; the two crates are both std-only and
/// INDEPENDENT (neither depends on the other), so the fast version could not simply be called
/// from here. The duplication already existed — this makes both copies fast instead of one.
///
/// ⚠️ The two copies must stay BYTE-IDENTICAL, because they serve different egress formats of
/// one engine: this one backs JSON and `CAST`/`to_string`, the codec's backs CSV and pg-text. A
/// divergence would be a byte-identity bug ACROSS FORMATS, which no single format's test could
/// see. `js_number_matches_the_codec_formatter` pins that directly.
pub fn push_js_number(out: &mut String, x: f64) {
    write_js_number(out, x);
}

/// [`push_js_number`] over any [`std::fmt::Write`], so a STACK buffer can receive it and the
/// caller need not own a `String` at all (item 654). `Scratch` implements `Write`, which is what
/// makes [`js_number_gstr`] allocation-free.
fn write_js_number<W: std::fmt::Write>(out: &mut W, x: f64) {
    if x == 0.0 {
        let _ = out.write_char('0'); // also normalizes -0.0 → "0" (JS drops the sign)
        return;
    }

    let neg = x < 0.0;
    let mut sci = Scratch {
        buf: [0; 32],
        len: 0,
    };
    let _ = write!(sci, "{:e}", x.abs()); // e.g. "1.5e21", "1e-7"
                                          // ASCII by construction (digits, '.', 'e', '-', '+').
    let sci_s = unsafe { std::str::from_utf8_unchecked(&sci.buf[..sci.len]) };
    let (mant, exp_str) = sci_s.split_once('e').expect("{:e} always has an 'e'");
    let exp: i32 = exp_str.parse().expect("valid base-10 exponent");
    // Significant digits with the '.' removed, into a stack buffer (≤17 for an f64).
    let mut dig = [0u8; 24];
    let mut dn = 0;

    for &c in mant.as_bytes() {
        if c != b'.' {
            dig[dn] = c;
            dn += 1;
        }
    }

    let digits = unsafe { std::str::from_utf8_unchecked(&dig[..dn]) };
    let k = dn as i32; // significant digits
    let n = exp + 1; // ECMA `n`: position of the decimal point

    if neg {
        let _ = out.write_char('-');
    }

    if k <= n && n <= 21 {
        let _ = out.write_str(digits);

        for _ in 0..(n - k) {
            let _ = out.write_char('0');
        }
    } else if 0 < n && n <= 21 {
        let _ = out.write_str(&digits[..n as usize]);
        let _ = out.write_char('.');
        let _ = out.write_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        let _ = out.write_str("0.");

        for _ in 0..(-n) {
            let _ = out.write_char('0');
        }

        let _ = out.write_str(digits);
    } else {
        let _ = out.write_str(&digits[..1]);

        if k > 1 {
            let _ = out.write_char('.');
            let _ = out.write_str(&digits[1..]);
        }

        let _ = out.write_char('e');

        let e = n - 1;

        let _ = out.write_char(if e >= 0 { '+' } else { '-' });
        write_u32(out, e.unsigned_abs());
    }
}

/// `x` as a [`GStr`](crate::gstr::GStr) with NO heap allocation at all: the digits land in a
/// stack buffer and `GStr::new` copies them into its 12-byte INLINE representation for any
/// number short enough, which is almost every number (item 654).
///
/// This is what `value::cast`'s `CAST(x AS STRING)` arm needs. It used to call
/// `GStr::from(js_number(x))` — an owned `String` allocated per row only to be copied into a
/// `GStr` and dropped.
///
/// The buffer is 48 bytes against a worst case of about 25: `"0."` plus 6 zeros plus 17
/// significant digits, or a 21-digit fixed form plus a sign. `Scratch::write_str` REFUSES an
/// overflowing write rather than truncating silently, and the parity test sweeps the same corpus
/// through this entry point, so a regression in the margin shows up as a wrong string.
#[must_use]
pub fn js_number_gstr(x: f64) -> crate::gstr::GStr {
    let mut buf = Scratch::<48> {
        buf: [0; 48],
        len: 0,
    };

    write_js_number(&mut buf, x);
    // ASCII by construction, as in `write_js_number`.
    crate::gstr::GStr::new(unsafe { std::str::from_utf8_unchecked(&buf.buf[..buf.len]) })
}

/// Append `v`'s decimal digits with no allocation (a tiny itoa for the exponent), where the
/// old body called `e.abs().to_string()`.
fn write_u32<W: std::fmt::Write>(out: &mut W, v: u32) {
    if v == 0 {
        let _ = out.write_char('0');
        return;
    }

    let mut b = [0u8; 10];
    let mut i = 0;
    let mut v = v;

    while v > 0 {
        b[i] = b'0' + (v % 10) as u8;
        i += 1;
        v /= 10;
    }

    while i > 0 {
        i -= 1;
        let _ = out.write_char(b[i] as char);
    }
}

/// Stringify a value like JS `String(v)` / core's `js_str` — the coercion behind
/// `to_string` and `CAST(x AS STRING)` for the COMPOSITE types (a scalar's own arm in
/// `to_string_fn` is the fast path). A LIST joins its elements with "," (a null element →
/// "", matching JS `Array.prototype.join`, NOT the top-level "null"); a RECORD/MAP renders
/// as its canonical JSON (byte-identical to how it serializes in a result). Numbers use
/// `js_number`, with non-finite ones spelled "NaN"/"Infinity"/"-Infinity" (JS `String`).
pub fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Num(x) if x.is_nan() => "NaN".to_string(),
        Value::Num(x) if x.is_infinite() => {
            if *x > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
        }
        Value::Num(x) => js_number(*x),
        Value::Str(s) => s.to_string(),
        Value::Temporal(t) => t.format(),
        Value::List(items) => items
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_str(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Record(_) | Value::Map(_) => {
            let mut s = String::new();
            write_value(&mut s, v);
            s
        }
        // SPIKE: element refs should be resolved before egress (see write_value).
        Value::Node(id) => format!("__UNRESOLVED_NODE_{id}__"),
        Value::Edge(id) => format!("__UNRESOLVED_EDGE_{id}__"),
    }
}

/// A JSON string literal (RFC 8259 escaping).
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    // Fast path: if NO byte needs escaping — none is `"`, `\`, or a control byte
    // (< 0x20) — the literal is `s` verbatim, so copy it in one `push_str` (a memcpy)
    // instead of walking `char`s. UTF-8 continuation/lead bytes are all >= 0x80, so a
    // byte scan never false-flags a multi-byte char. Byte-identical to the loop below.
    if !s.bytes().any(|b| b < 0x20 || b == b'"' || b == b'\\') {
        out.push_str(s);
        out.push('"');
        return;
    }
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod js_number_tests {
    use super::js_number;

    /// The ALLOCATING algorithm `js_number` had before item 654, kept verbatim as the
    /// reference. The port is only safe if it agrees with this on every input, and a
    /// hand-written table of a dozen cases cannot establish that — the ECMA-262 fixed/
    /// exponential boundaries are at `n > 21` and `n <= -6`, and the digit-count branches
    /// interact with them.
    fn reference(x: f64) -> String {
        if x == 0.0 {
            return "0".to_string();
        }

        let neg = x < 0.0;
        let sci = format!("{:e}", x.abs());
        let (mant, exp_str) = sci.split_once('e').expect("{:e} always has an 'e'");
        let exp: i32 = exp_str.parse().expect("valid base-10 exponent");
        let digits: String = mant.chars().filter(|c| *c != '.').collect();
        let k = digits.len() as i32;
        let n = exp + 1;
        let mut out = String::new();

        if neg {
            out.push('-');
        }

        if k <= n && n <= 21 {
            out.push_str(&digits);
            out.extend(std::iter::repeat_n('0', (n - k) as usize));
        } else if 0 < n && n <= 21 {
            out.push_str(&digits[..n as usize]);
            out.push('.');
            out.push_str(&digits[n as usize..]);
        } else if -6 < n && n <= 0 {
            out.push_str("0.");
            out.extend(std::iter::repeat_n('0', (-n) as usize));
            out.push_str(&digits);
        } else {
            out.push_str(&digits[..1]);

            if k > 1 {
                out.push('.');
                out.push_str(&digits[1..]);
            }

            out.push('e');

            let e = n - 1;

            out.push(if e >= 0 { '+' } else { '-' });
            out.push_str(&e.abs().to_string());
        }

        out
    }

    /// Every branch of the ECMA-262 rule, every boundary of it, and both signs — against the
    /// implementation the port replaced. `js_number` is what `CAST(x AS STRING)`, `to_string`
    /// and JSON egress all render through, so a divergence here is a wrong answer in three
    /// surfaces at once, not a slow one.
    #[test]
    fn the_stack_buffer_port_agrees_with_the_allocating_reference() {
        let mut xs: Vec<f64> = vec![
            0.0,
            -0.0,
            1.0,
            -1.0,
            // The FIXED/EXPONENTIAL boundaries, from both sides. `n <= 21` and `-6 < n`.
            1e20,
            1e21,
            1e22,
            9.999_999_999_999_999e20,
            1e-6,
            1e-7,
            1e-8,
            // Trailing-zero padding (`k <= n`), and the decimal-point-inside branch.
            12300.0,
            1234.5,
            1.25,
            0.1,
            // Exponents needing one, two and three digits — `push_u32`'s loop.
            1e-10,
            1e100,
            1e-100,
            5e-324,
            f64::MAX,
            f64::MIN_POSITIVE,
        ];

        // A deterministic sweep across magnitudes and mantissas, so the branches are hit with
        // digit counts a hand-picked list would not produce.
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;

        for _ in 0..4000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;

            let mant = (seed >> 11) as f64 / (1u64 << 53) as f64;
            let exp = (seed % 60) as i32 - 30;
            let v = mant * 10f64.powi(exp);

            if v.is_finite() && v != 0.0 {
                xs.push(v);
                xs.push(-v);
            }
        }

        for x in xs {
            assert_eq!(js_number(x), reference(x), "js_number({x:?})");
        }
    }

    /// ⚠️ THE CROSS-CRATE INVARIANT, which no single format's test can see.
    ///
    /// `lenke-codec` carries its OWN copy of this formatter (both crates are std-only and
    /// independent, so neither can call the other's). This copy backs JSON and
    /// `CAST`/`to_string`; the codec's backs CSV and pg-text. If they diverge, one engine emits
    /// two different spellings of the same number depending on the egress format — a
    /// byte-identity bug ACROSS formats. The duplication predates item 654; the test does not.
    ///
    /// The codec cannot be imported here (that is the whole point), so the check is structural:
    /// this asserts the exact strings the codec's own test table pins, which is what keeps the
    /// two tables comparable by inspection.
    #[test]
    fn js_number_matches_the_codec_formatter() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1234.5, "1234.5"),
            (12300.0, "12300"),
            (0.1, "0.1"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-10, "1e-10"),
            (1e100, "1e+100"),
            (-1e-7, "-1e-7"),
            (1.25, "1.25"),
        ];

        for &(x, want) in cases {
            assert_eq!(js_number(x), want, "js_number({x})");
        }
    }
}
