//! Measure the REAL cost of content-derived CDC scope extraction: after a write
//! commits, reading a scope property off the touched element(s). The engine already
//! collects the touched ids (`tx_touched`, for deferred constraint checks) and the
//! commit already walks them reading props — so extraction rides an existing loop.
//! This isolates the two primitives: (1) a single scope-property read, and (2) the
//! full GQL write it rides on, so we can size extraction as a fraction of the write.
//!
//! Run (from crates/lenke-core):
//!   cargo run --release --example cdc_extract_bench [vertices]

use std::time::Instant;

use lenke_core::gql;
use lenke_core::graph::Value;
use lenke_core::ndjson;

fn main() {
    let v: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200_000);
    let rooms = 1000usize;

    let mut lines = String::with_capacity(v * 80);
    for i in 0..v {
        lines.push_str(&format!(
            r#"{{"type":"node","id":"m{i}","labels":["Msg"],"properties":{{"room":{},"body":"hello world"}}}}"#,
            i % rooms
        ));
        lines.push('\n');
    }
    let mut g = ndjson::decode(lines.trim_end()).unwrap();
    println!("built {v} Msg vertices across {rooms} rooms\n");

    // (1) Extraction primitive: read the "room" scope property off every vertex.
    // This is what the commit does per touched element (one read per touched id).
    let mut sink = 0.0f64;
    let t = Instant::now();
    for idx in 0..v {
        if let Value::Num(x) = g.props.value(idx, "room", &g.strs) {
            sink += x;
        }
    }
    let read_ns = t.elapsed().as_nanos() as f64 / v as f64;
    println!(
        "(1) scope-property read : {read_ns:.1} ns/read   (sink={})",
        sink as u64 & 1
    );

    // (2) The full GQL write the extraction rides on (parse + apply + commit).
    let params = gql::eval::Params::new();
    let w = 20_000usize;
    let t = Instant::now();
    for i in 0..w {
        let q = format!("INSERT (:Msg {{room: {}, body: 'x'}})", i % rooms);
        gql::parse(&q).unwrap().execute(&mut g, &params).unwrap();
    }
    let write_ns = t.elapsed().as_nanos() as f64 / w as f64;
    println!("(2) full GQL INSERT     : {write_ns:.0} ns/write\n");

    // Extraction cost for a write that touches K elements = K scope-reads.
    println!("extraction as a fraction of the write it rides on:");
    for k in [1usize, 3, 10] {
        let ext = k as f64 * read_ns;
        println!(
            "  K={k:<2} touched: {ext:.0} ns/write  ({:.3}% of the write)",
            100.0 * ext / write_ns
        );
    }
}
