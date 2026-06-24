//! Zero-copy columnar result encoding in the **Apache Arrow** in-memory format.
//!
//! A query result is single-owner and consume-once, so instead of serializing it
//! to JSON (serialize on this side, parse on the caller's) we lay the columns out
//! as Arrow buffers — a validity bitmap plus a typed values/offsets buffer per
//! column — inside one self-describing blob. The caller (bun:ffi on the server,
//! wasm + `apache-arrow` in the browser) views those buffers in place with no
//! copy and no parse: numeric columns become a `Float64Array` over the same
//! bytes, strings an offsets+data pair, etc.
//!
//! The buffers themselves are exactly Arrow's columnar spec (little-endian,
//! 8-byte aligned, LSB-first validity bitmap, `i32` Utf8 offsets), so the JS side
//! reconstructs real `arrow.Vector`s via `makeData` with zero copy. The envelope
//! around them is a compact custom header (below) rather than Arrow's flatbuffer
//! IPC framing — that keeps this dependency-free; an IPC-stream wrapper (for
//! `tableFromIPC`) can layer on top later without changing the buffers.
//!
//! ## Blob layout (all integers little-endian)
//! ```text
//! header (24 bytes):  magic "ARW1" | version:u32 | nrows:u64 | ncols:u64
//! column descriptors (ncols × 40 bytes), each:
//!   type:u32  null_count:u32
//!   name_off:u32 name_len:u32          (utf8 column name)
//!   validity_off:u32 validity_len:u32  (bitmap; len 0 ⇒ no nulls)
//!   buf1_off:u32 buf1_len:u32          (Float64: values; Bool: bitmap; Utf8: i32 offsets[n+1])
//!   buf2_off:u32 buf2_len:u32          (Utf8: data bytes; else len 0)
//! body: every referenced buffer, each 8-byte aligned; offsets are blob-relative.
//! ```
//! The blob's base pointer is 8-byte aligned by the FFI allocator, and every
//! buffer offset is a multiple of 8, so `Float64Array`/`Int32Array` views are
//! valid directly over `(base + off)`.

use std::fmt::Write as _;

use crate::graph::Value;
use crate::query::RowSet;

/// Arrow type tag (a minimal subset: every result cell maps to one of these).
pub const T_FLOAT64: u32 = 1;
pub const T_BOOL: u32 = 2;
pub const T_UTF8: u32 = 3;

const HEADER_LEN: usize = 24;
const COLDESC_LEN: usize = 40;

/// Round `v` up to a multiple of 8 (Arrow buffer alignment).
fn align8(v: usize) -> usize {
    (v + 7) & !7
}

/// Render a cell as text for a Utf8 column (validity carries the null, so a null
/// contributes an empty span).
fn cell_str(c: &Value, out: &mut String) {
    match c {
        Value::Null => {}
        Value::Str(s) => out.push_str(s),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            let _ = write!(out, "{n}");
        }
        Value::List(items) => {
            out.push('[');
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                cell_str(it, out);
            }
            out.push(']');
        }
    }
}

/// One column's built Arrow buffers (pre-assembly).
/// A single result column in typed form (the Arrow physical types we emit).
/// `valid = None` means no nulls. The vectorized engine builds `Num`/`Bool`
/// straight from its `f64`/`bool` columns — no `Val`/`Value` boxing — while
/// `from_values` covers the scalar/RowSet path and string/element columns.
pub enum ArrowColumn {
    Num {
        data: Vec<f64>,
        valid: Option<Vec<bool>>,
    },
    Bool {
        data: Vec<bool>,
        valid: Option<Vec<bool>>,
    },
    Utf8 {
        offsets: Vec<i32>,
        bytes: Vec<u8>,
        valid: Option<Vec<bool>>,
    },
}

impl ArrowColumn {
    /// Build a column from generic `Value` cells (infers the physical type).
    pub fn from_values<'a>(cells: impl Iterator<Item = &'a Value>) -> ArrowColumn {
        let cells: Vec<&Value> = cells.collect();
        let n = cells.len();
        let mut seen_num = false;
        let mut seen_bool = false;
        let mut seen_other = false;
        let mut any_null = false;
        let mut valid = vec![true; n];
        for (i, c) in cells.iter().enumerate() {
            match c {
                Value::Null => {
                    valid[i] = false;
                    any_null = true;
                }
                Value::Num(_) => seen_num = true,
                Value::Bool(_) => seen_bool = true,
                _ => seen_other = true,
            }
        }
        let valid = if any_null { Some(valid) } else { None };
        if seen_other || (seen_num && seen_bool) {
            let mut offsets = Vec::with_capacity(n + 1);
            let mut bytes = Vec::new();
            let mut s = String::new();
            offsets.push(0i32);
            for c in &cells {
                s.clear();
                cell_str(c, &mut s);
                bytes.extend_from_slice(s.as_bytes());
                offsets.push(bytes.len() as i32);
            }
            ArrowColumn::Utf8 {
                offsets,
                bytes,
                valid,
            }
        } else if seen_bool {
            ArrowColumn::Bool {
                data: cells
                    .iter()
                    .map(|c| matches!(c, Value::Bool(true)))
                    .collect(),
                valid,
            }
        } else {
            ArrowColumn::Num {
                data: cells
                    .iter()
                    .map(|c| if let Value::Num(x) = c { *x } else { 0.0 })
                    .collect(),
                valid,
            }
        }
    }

    /// Build a Utf8 column from already-rendered strings (one per row, `None` =
    /// null). Lets the engine flatten element/string columns once, in place.
    pub fn utf8_from(strings: impl Iterator<Item = Option<String>>) -> ArrowColumn {
        let mut offsets = vec![0i32];
        let mut bytes = Vec::new();
        let mut valid = Vec::new();
        let mut any_null = false;
        for s in strings {
            match s {
                Some(s) => {
                    bytes.extend_from_slice(s.as_bytes());
                    valid.push(true);
                }
                None => {
                    any_null = true;
                    valid.push(false);
                }
            }
            offsets.push(bytes.len() as i32);
        }
        ArrowColumn::Utf8 {
            offsets,
            bytes,
            valid: if any_null { Some(valid) } else { None },
        }
    }

    fn valid_mask(&self) -> &Option<Vec<bool>> {
        match self {
            ArrowColumn::Num { valid, .. }
            | ArrowColumn::Bool { valid, .. }
            | ArrowColumn::Utf8 { valid, .. } => valid,
        }
    }

    /// (type tag, null_count, validity bitmap, buf1, buf2) for blob assembly.
    fn encode(&self, nrows: usize) -> (u32, u32, Vec<u8>, Vec<u8>, Vec<u8>) {
        let (null_count, validity) = match self.valid_mask() {
            None => (0, Vec::new()),
            Some(mask) => {
                let mut bitmap = vec![0u8; nrows.div_ceil(8)];
                let mut nulls = 0u32;
                for (i, &v) in mask.iter().enumerate() {
                    if v {
                        bitmap[i / 8] |= 1 << (i % 8);
                    } else {
                        nulls += 1;
                    }
                }
                (nulls, bitmap)
            }
        };
        let (tag, buf1, buf2) = match self {
            ArrowColumn::Num { data, .. } => {
                let mut b = Vec::with_capacity(data.len() * 8);
                for v in data {
                    b.extend_from_slice(&v.to_le_bytes());
                }
                (T_FLOAT64, b, Vec::new())
            }
            ArrowColumn::Bool { data, .. } => {
                let mut b = vec![0u8; data.len().div_ceil(8)];
                for (i, &v) in data.iter().enumerate() {
                    if v {
                        b[i / 8] |= 1 << (i % 8);
                    }
                }
                (T_BOOL, b, Vec::new())
            }
            ArrowColumn::Utf8 { offsets, bytes, .. } => {
                let mut b = Vec::with_capacity(offsets.len() * 4);
                for o in offsets {
                    b.extend_from_slice(&o.to_le_bytes());
                }
                (T_UTF8, b, bytes.clone())
            }
        };
        (tag, null_count, validity, buf1, buf2)
    }
}

/// Encode a [`RowSet`] as an Arrow columnar blob (see module docs for layout).
/// Assemble an Arrow columnar blob from typed columns (see module docs for the
/// layout). `nrows` is the row count (columns must all be that long).
pub fn to_arrow_cols(names: &[String], cols: &[ArrowColumn], nrows: usize) -> Vec<u8> {
    let ncols = cols.len();
    #[allow(
        clippy::type_complexity,
        reason = "ad-hoc per-column (tag, null_count, validity, buf1, buf2) tuple local to encoding"
    )]
    let encoded: Vec<(u32, u32, Vec<u8>, Vec<u8>, Vec<u8>)> =
        cols.iter().map(|c| c.encode(nrows)).collect();

    // Body base: after header + descriptors, aligned to 8.
    let body_base = align8(HEADER_LEN + ncols * COLDESC_LEN);
    let mut body: Vec<u8> = Vec::new();
    let mut descs: Vec<[u32; 10]> = Vec::with_capacity(ncols);
    for (j, (tag, null_count, validity, buf1, buf2)) in encoded.iter().enumerate() {
        let mut place = |bytes: &[u8]| -> (u32, u32) {
            while !body.len().is_multiple_of(8) {
                body.push(0);
            }
            let off = (body_base + body.len()) as u32;
            body.extend_from_slice(bytes);
            (off, bytes.len() as u32)
        };
        let (name_off, name_len) = place(names[j].as_bytes());
        let (val_off, val_len) = place(validity);
        let (b1_off, b1_len) = place(buf1);
        let (b2_off, b2_len) = place(buf2);
        descs.push([
            *tag,
            *null_count,
            name_off,
            name_len,
            val_off,
            val_len,
            b1_off,
            b1_len,
            b2_off,
            b2_len,
        ]);
    }

    // Assemble: header, descriptors, pad to body_base, body.
    let mut blob = Vec::with_capacity(body_base + body.len());
    blob.extend_from_slice(b"ARW1");
    blob.extend_from_slice(&1u32.to_le_bytes());
    blob.extend_from_slice(&(nrows as u64).to_le_bytes());
    blob.extend_from_slice(&(ncols as u64).to_le_bytes());
    for d in &descs {
        for w in d {
            blob.extend_from_slice(&w.to_le_bytes());
        }
    }
    while blob.len() < body_base {
        blob.push(0);
    }
    blob.extend_from_slice(&body);
    blob
}

/// Encode a [`RowSet`] as an Arrow columnar blob (the scalar / fallback path,
/// inferring each column's type from its `Value` cells).
pub fn to_arrow(rs: &RowSet) -> Vec<u8> {
    let ncols = rs.cols.len();
    let cols: Vec<ArrowColumn> = (0..ncols)
        .map(|j| ArrowColumn::from_values((0..rs.nrows).map(move |i| &rs.data[i * ncols + j])))
        .collect();
    to_arrow_cols(&rs.cols, &cols, rs.nrows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn u32_at(b: &[u8], off: usize) -> u32 {
        u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
    }
    fn u64_at(b: &[u8], off: usize) -> u64 {
        u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
    }

    /// Decode the blob back into (type, nulls, values) per column to verify the
    /// layout round-trips — the same reading a JS consumer does.
    #[allow(
        clippy::type_complexity,
        reason = "ad-hoc decoded-column tuple in a round-trip test helper"
    )]
    fn decode(blob: &[u8]) -> (usize, Vec<(u32, Vec<Option<String>>)>) {
        assert_eq!(&blob[0..4], b"ARW1");
        let nrows = u64_at(blob, 8) as usize;
        let ncols = u64_at(blob, 16) as usize;
        let mut out = Vec::new();
        for j in 0..ncols {
            let d = HEADER_LEN + j * COLDESC_LEN;
            let tag = u32_at(blob, d);
            let null_count = u32_at(blob, d + 4);
            let val_off = u32_at(blob, d + 16) as usize;
            let val_len = u32_at(blob, d + 20) as usize;
            let b1_off = u32_at(blob, d + 24) as usize;
            let b2_off = u32_at(blob, d + 32) as usize;
            let b2_len = u32_at(blob, d + 36) as usize;
            // alignment invariant: every buffer offset is 8-aligned.
            assert_eq!(b1_off % 8, 0, "buf1 must be 8-aligned");
            let valid = |i: usize| -> bool {
                if val_len == 0 {
                    return true; // no bitmap ⇒ all valid
                }
                blob[val_off + i / 8] & (1 << (i % 8)) != 0
            };
            let mut vals = Vec::with_capacity(nrows);
            let mut seen_nulls = 0;
            for i in 0..nrows {
                if !valid(i) {
                    seen_nulls += 1;
                    vals.push(None);
                    continue;
                }
                let s = match tag {
                    T_FLOAT64 => {
                        let o = b1_off + i * 8;
                        format!("{}", f64::from_le_bytes(blob[o..o + 8].try_into().unwrap()))
                    }
                    T_BOOL => (blob[b1_off + i / 8] & (1 << (i % 8)) != 0).to_string(),
                    _ => {
                        let start = u32_at(blob, b1_off + i * 4) as usize;
                        let end = u32_at(blob, b1_off + (i + 1) * 4) as usize;
                        assert!(end <= b2_len);
                        String::from_utf8(blob[b2_off + start..b2_off + end].to_vec()).unwrap()
                    }
                };
                vals.push(Some(s));
            }
            assert_eq!(seen_nulls as u32, null_count);
            out.push((tag, vals));
        }
        (nrows, out)
    }

    fn rowset(cols: &[&str], rows: Vec<Vec<Value>>) -> RowSet {
        let mut rs = RowSet::new(cols.iter().map(|s| s.to_string()).collect());
        for r in rows {
            rs.push_row(r);
        }
        rs
    }

    #[test]
    fn float_bool_utf8_roundtrip() {
        let s = |x: &str| Value::Str(Arc::from(x));
        let rs = rowset(
            &["age", "flag", "name"],
            vec![
                vec![Value::Num(29.0), Value::Bool(true), s("marko")],
                vec![Value::Num(35.0), Value::Bool(false), s("peter")],
            ],
        );
        let blob = to_arrow(&rs);
        let (nrows, cols) = decode(&blob);
        assert_eq!(nrows, 2);
        assert_eq!(cols[0].0, T_FLOAT64);
        assert_eq!(cols[1].0, T_BOOL);
        assert_eq!(cols[2].0, T_UTF8);
        assert_eq!(cols[0].1, vec![Some("29".into()), Some("35".into())]);
        assert_eq!(cols[1].1, vec![Some("true".into()), Some("false".into())]);
        assert_eq!(cols[2].1, vec![Some("marko".into()), Some("peter".into())]);
    }

    #[test]
    fn nulls_set_validity_bitmap() {
        let s = |x: &str| Value::Str(Arc::from(x));
        let rs = rowset(
            &["n", "name"],
            vec![
                vec![Value::Num(1.0), s("a")],
                vec![Value::Null, Value::Null],
            ],
        );
        let blob = to_arrow(&rs);
        let (nrows, cols) = decode(&blob);
        assert_eq!(nrows, 2);
        assert_eq!(cols[0].1, vec![Some("1".into()), None]);
        assert_eq!(cols[1].1, vec![Some("a".into()), None]);
        // null_count recorded per column
        assert_eq!(u32_at(&blob, HEADER_LEN + 4), 1);
    }

    #[test]
    fn mixed_column_falls_back_to_utf8() {
        let s = |x: &str| Value::Str(Arc::from(x));
        let rs = rowset(&["x"], vec![vec![Value::Num(1.0)], vec![s("hi")]]);
        let blob = to_arrow(&rs);
        let (_, cols) = decode(&blob);
        assert_eq!(cols[0].0, T_UTF8);
        assert_eq!(cols[0].1, vec![Some("1".into()), Some("hi".into())]);
    }

    #[test]
    fn empty_result_is_valid_blob() {
        let rs = rowset(&["a", "b"], vec![]);
        let blob = to_arrow(&rs);
        let (nrows, cols) = decode(&blob);
        assert_eq!(nrows, 0);
        assert_eq!(cols.len(), 2);
    }

    #[test]
    fn end_to_end_query_to_arrow() {
        // Real path: decode a graph, run a GQL query, encode the RowSet as Arrow.
        let lines = [
            r#"{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}"#,
            r#"{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}"#,
        ];
        let mut g = crate::ndjson::decode(&lines.join("\n")).unwrap();
        let rs = crate::gql::parse("MATCH (n:P) RETURN n.name, n.age ORDER BY n.age")
            .unwrap()
            .execute(&mut g, &crate::gql::eval::Params::new())
            .unwrap();
        let (nrows, cols) = decode(&to_arrow(&rs));
        assert_eq!(nrows, 2);
        assert_eq!(cols[0].0, T_UTF8); // name
        assert_eq!(cols[1].0, T_FLOAT64); // age
        assert_eq!(cols[0].1, vec![Some("vadas".into()), Some("marko".into())]); // age-sorted
        assert_eq!(cols[1].1, vec![Some("27".into()), Some("29".into())]);
    }

    #[test]
    fn typed_path_matches_rowset_path() {
        // The boxing-free `execute_arrow` must produce byte-identical Arrow to the
        // RowSet path (`to_arrow(execute())`) for every shape — typed fast path
        // (plain projection) and fallback (aggregate / mixed / nulls) alike.
        let lines = [
            r#"{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29,"active":true}}"#,
            r#"{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}"#,
            r#"{"type":"node","id":"c","labels":["P"],"properties":{"name":"josh","age":32,"active":false}}"#,
        ];
        let queries = [
            "MATCH (n:P) RETURN n.name, n.age", // typed: Utf8 + Float64
            "MATCH (n:P) RETURN n.active",      // typed: Bool with a null
            "MATCH (n:P) WHERE n.age > 28 RETURN n.age", // typed + WHERE
            "MATCH (n:P) RETURN n.age * 2 + 1 AS x", // typed: computed numeric
            "MATCH (n:P) RETURN count(*) AS c", // fallback: aggregate
            "MATCH (n:P) RETURN n.dept",        // all-null column
        ];
        for q in queries {
            let mut g1 = crate::ndjson::decode(&lines.join("\n")).unwrap();
            let mut g2 = crate::ndjson::decode(&lines.join("\n")).unwrap();
            let params = crate::gql::eval::Params::new();
            let typed = crate::gql::parse(q)
                .unwrap()
                .execute_arrow(&mut g1, &params)
                .unwrap();
            let rs = crate::gql::parse(q)
                .unwrap()
                .execute(&mut g2, &params)
                .unwrap();
            assert_eq!(typed, to_arrow(&rs), "blob mismatch for `{q}`");
        }
    }
}
