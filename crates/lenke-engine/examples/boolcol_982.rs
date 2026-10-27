//! Item 982: does a stored NULL stop a boolean column being a `Column::Bool`?
use lenke_engine::store::{Builder, Column, Store};
use lenke_engine::value::Value;

fn probe(name: &str, build: impl Fn(&mut Builder)) {
    let mut b = Builder::default();
    build(&mut b);
    let s: Store = b.build();
    let kind = match s.column("b") {
        Some(Column::Bool { .. }) => "Column::Bool",
        Some(Column::Gen { .. }) => "Column::Gen",
        Some(_) => "other typed",
        None => "no column",
    };
    println!("  {name:34} -> {kind}");
}

fn main() {
    probe("all present, true/false", |b| {
        for i in 0..50 {
            b.node(&["P"], &[("b", Value::Bool(i % 2 == 0))]);
        }
    });
    probe("+ one ABSENT cell", |b| {
        for i in 0..50 {
            b.node(&["P"], &[("b", Value::Bool(i % 2 == 0))]);
        }
        b.node(&["P"], &[("tag", Value::Str("x".into()))]);
    });
    probe("+ one STORED NULL", |b| {
        for i in 0..50 {
            b.node(&["P"], &[("b", Value::Bool(i % 2 == 0))]);
        }
        b.node(&["P"], &[("b", Value::Null)]);
    });
}
