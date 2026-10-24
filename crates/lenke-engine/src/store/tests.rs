use super::*;

#[test]
fn version_bumps_on_every_mutation() {
    let mut s = Store::default();
    assert_eq!(s.version(), 0);
    let a = s.add_node(&["N"], &[]);
    let v1 = s.version();
    assert!(v1 > 0, "add_node bumps version");
    let b = s.add_node(&["N"], &[]);
    assert!(s.version() > v1, "second add_node bumps again");
    let v2 = s.version();
    let e = s.add_edge(a, b, "R");
    assert!(s.version() > v2, "add_edge bumps");
    let v3 = s.version();
    s.set_prop(a, "k", Value::Num(1.0));
    assert!(s.version() > v3, "set_prop bumps");
    let v4 = s.version();
    s.delete_edge(a, b, e);
    assert!(s.version() > v4, "delete_edge bumps");
}

#[test]
fn epoch_bumps_only_the_tokens_a_change_touches() {
    let mut st = Store::default();
    let a = st.add_node(&["Person"], &[("name", s("alice"))]);
    // Both the label and the property key were touched by the add.
    let (p0, n0) = (st.epoch("Person"), st.epoch("name"));
    assert!(p0 > 0 && n0 > 0);
    assert_eq!(st.epoch("Project"), 0, "an untouched token stays 0");

    // A property change bumps only that property's epoch, not the label's.
    st.set_prop(a, "age", Value::Num(30.0));
    assert!(st.epoch("age") > n0);
    assert_eq!(st.epoch("Person"), p0, "unrelated label epoch is unchanged");
    assert_eq!(
        st.epoch("name"),
        n0,
        "unrelated property epoch is unchanged"
    );

    // Epoch never exceeds the global version.
    assert!(st.epoch("age") <= st.version());
}

#[test]
fn clone_is_deep_and_independent() {
    let mut s = Store::default();
    let a = s.add_node(&["N"], &[("k", Value::Num(1.0))]);
    let b = s.add_node(&["N"], &[]);
    s.add_edge(a, b, "R");
    let ver = s.version();
    let snap = s.clone();
    assert_eq!(snap.version(), ver, "clone copies the version");
    // Mutating the original must not touch the clone.
    s.add_node(&["N"], &[]);
    assert_eq!(snap.node_count(), 2, "clone unaffected by later mutation");
    assert_eq!(s.node_count(), 3);
    assert_eq!(snap.edge_count(), 1);
    assert_eq!(snap.version(), ver, "clone version is frozen at copy time");
}

/// The CSR read overlay must (a) match the per-node adjacency exactly after a
/// build, (b) reflect a write IMMEDIATELY (invalidation → Vec fallback), and
/// (c) match again after an explicit rebuild.
#[test]
fn csr_overlay_matches_and_invalidates_on_write() {
    let mut b = Builder::default();
    b.node(&["N"], &[]);
    b.node(&["N"], &[]);
    b.node(&["N"], &[]);
    b.edge(0, 1, "R");
    b.edge(0, 2, "R");
    let mut st = b.build();
    let out = |st: &Store, v: u32| -> Vec<u32> { st.out(v).iter().map(|a| a.nbr).collect() };
    let inc = |st: &Store, v: u32| -> Vec<u32> { st.inc(v).iter().map(|a| a.nbr).collect() };
    // (a) fresh CSR after build: neighbour ORDER preserved.
    assert!(st.csr_fresh);
    assert_eq!(out(&st, 0), vec![1, 2]);
    // (b) a write clears the overlay and is visible at once via the Vec fallback.
    st.add_edge(0, 1, "R");
    assert!(!st.csr_fresh);
    assert_eq!(out(&st, 0), vec![1, 2, 1]);
    assert_eq!(inc(&st, 1), vec![0, 0]);
    // (c) rebuild re-enables the CSR and it still matches.
    st.rebuild_csr();
    assert!(st.csr_fresh);
    assert_eq!(out(&st, 0), vec![1, 2, 1]);
    assert_eq!(inc(&st, 1), vec![0, 0]);
}

fn s(x: &str) -> Value {
    Value::Str(x.into())
}
fn n(x: f64) -> Value {
    Value::Num(x)
}

#[test]
fn temporal_props_use_a_typed_column_and_promote_on_mixed_kind() {
    use crate::temporal::{Date, Temporal, TemporalKind, Time};
    let d = |iso: &str| Value::Temporal(Temporal::Date(Date::parse(iso).unwrap()));
    let mut b = Builder::default();
    b.node(&["P"], &[("born", d("1990-01-01"))]);
    b.node(&["P"], &[("born", d("2000-01-01"))]);
    let mut st = b.build();
    // Homogeneous Date props de-box into a typed Temporal column of kind Date.
    assert!(matches!(
        st.column("born"),
        Some(Column::Temporal {
            kind: TemporalKind::Date,
            ..
        })
    ));
    match st.prop(0, "born") {
        Value::Temporal(Temporal::Date(x)) => assert_eq!(x.format(), "1990-01-01"),
        o => panic!("expected a Date, got {o:?}"),
    }
    // Writing a DIFFERENT temporal kind promotes the column to Gen; both
    // values still read back correctly.
    st.set_prop(
        1,
        "born",
        Value::Temporal(Temporal::Time(Time::parse("12:00:00").unwrap())),
    );
    assert!(matches!(st.column("born"), Some(Column::Gen { .. })));
    assert!(matches!(
        st.prop(0, "born"),
        Value::Temporal(Temporal::Date(_))
    ));
    assert!(matches!(
        st.prop(1, "born"),
        Value::Temporal(Temporal::Time(_))
    ));
}

#[test]
fn commit_records_the_change_list_rollback_records_nothing() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[]); // outside a txn → nothing observed
    assert!(st.last_commit_changes().is_empty());

    // A committed transaction publishes exactly its changes, in order.
    st.begin();
    let b = st.add_node(&["P"], &[("name", s("b"))]);
    st.set_prop(a, "age", n(1.0));
    let eid = st.add_edge(a, b, "R");
    st.commit();
    assert_eq!(
        st.last_commit_changes(),
        &[
            Change::NodeAdded(b),
            Change::NodeProp {
                node: a,
                key: "age".into(),
            },
            Change::EdgeAdded(eid),
        ]
    );

    // A rolled-back transaction publishes nothing: `last_commit` still shows
    // the previous COMMIT, unchanged (rollback is not an event).
    let previous: Vec<Change> = st.last_commit_changes().to_vec();
    st.begin();
    st.set_prop(a, "age", n(2.0));
    st.rollback();
    assert_eq!(st.last_commit_changes(), previous.as_slice());
}

#[test]
fn touched_scopes_are_the_distinct_rooms_a_commit_writes() {
    let str_scopes = |scopes: &[Value]| -> Vec<String> {
        scopes
            .iter()
            .map(|v| match v {
                Value::Str(x) => x.to_string(),
                o => format!("{o:?}"),
            })
            .collect()
    };
    let mut st = Builder::default().build();
    st.begin();
    st.add_node(&["Msg"], &[("room", s("A"))]);
    st.add_node(&["Msg"], &[("room", s("B"))]);
    st.add_node(&["Msg"], &[("room", s("A"))]); // duplicate room A
    st.commit();
    let (scopes, open) = st.touched_scopes("room");
    assert_eq!(str_scopes(&scopes), vec!["A", "B"]); // distinct, sorted
    assert!(!open); // every change was scopable

    // A node with no `room` property → fail-open (visible to all).
    st.begin();
    st.add_node(&["Sys"], &[]);
    st.commit();
    let (scopes2, open2) = st.touched_scopes("room");
    assert!(scopes2.is_empty());
    assert!(open2);
}

#[test]
fn last_write_scope_json_renders_scopes_and_open_flag() {
    let mut st = Builder::default().build();
    st.begin();
    st.add_node(&["Msg"], &[("room", s("A"))]);
    st.add_node(&["Msg"], &[("room", s("B"))]);
    st.commit();
    assert_eq!(
        st.last_write_scope_json("room"),
        r#"{"scopes":["A","B"],"open":false}"#
    );

    // An unscopable change (no `room`) flips open to true.
    st.begin();
    st.add_node(&["Sys"], &[]);
    st.commit();
    assert_eq!(
        st.last_write_scope_json("room"),
        r#"{"scopes":[],"open":true}"#
    );
}

#[test]
fn cdc_reports_delete_as_one_node_deleted() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[]);
    let b = st.add_node(&["P"], &[]);
    st.add_edge(a, b, "R");
    st.begin();
    st.delete_node(a); // cascades the edge — reported as one NodeDeleted
    st.commit();
    assert_eq!(st.last_commit_changes(), &[Change::NodeDeleted(a)]);
}

#[test]
fn set_null_no_longer_de_opts_the_column() {
    use crate::value::Value;
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("age", n(30.0))]);
    let _b = st.add_node(&["P"], &[("age", n(40.0))]);
    assert!(
        matches!(st.column("age"), Some(Column::Num { .. })),
        "starts Num"
    );
    st.set_prop(a, "age", Value::Null); // present-null
    assert!(
        matches!(st.column("age"), Some(Column::Num { .. })),
        "SET null keeps the column TYPED (no Gen de-opt) — the footgun is gone"
    );
    assert!(
        st.has_prop(a, "age") && st.prop(a, "age").is_null(),
        "present-null"
    );
    assert!(
        matches!(st.prop(_b, "age"), Value::Num(x) if x == 40.0),
        "sibling value intact + typed"
    );
    // remove the null -> column stays Num, node absent
    st.remove_prop(a, "age");
    assert!(!st.has_prop(a, "age"));
    assert!(matches!(st.column("age"), Some(Column::Num { .. })));
}

#[test]
fn required_constraint_declared_and_checked() {
    let mut st = Builder::default().build();
    st.add_node(&["User"], &[("email", s("a@x"))]);
    // Every User has email → the constraint declares, and the check passes.
    assert!(st.create_required_constraint("User", "email").is_ok());
    assert!(st.check_required_for_label("User").is_ok());
    // A User missing email → the check fails (present-null would pass; absence
    // is the violation).
    st.add_node(&["User"], &[("name", s("b"))]);
    assert!(st.check_required_for_label("User").is_err());
    // Declaring on already-violating data errors.
    let mut st2 = Builder::default().build();
    st2.add_node(&["User"], &[("name", s("x"))]);
    assert!(st2.create_required_constraint("User", "email").is_err());
}

#[test]
fn dotted_path_index_maintained_through_mutations() {
    use crate::value::make_record;
    let city = |c: &str| make_record(vec![(crate::gstr::GStr::from("city"), s(c))]);
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("meta", city("NYC"))]);
    let b = st.add_node(&["P"], &[("meta", city("LA"))]);
    let c = st.add_node(&["P"], &[("meta", city("NYC"))]);
    // Built from existing data: index on the record sub-field `meta.city`.
    st.create_index("meta.city");
    let nyc = |st: &Store| {
        let mut v = st.index_lookup("meta.city", &s("NYC")).unwrap();
        v.sort_unstable();
        v
    };
    assert_eq!(nyc(&st), vec![a, c]);
    assert_eq!(st.index_lookup("meta.city", &s("LA")).unwrap(), vec![b]);

    // Maintained on a write: change b's city to NYC.
    st.set_prop(b, "meta", city("NYC"));
    assert_eq!(nyc(&st), vec![a, b, c]);
    // …and on delete.
    st.delete_node(a);
    assert_eq!(nyc(&st), vec![b, c]);
    // No index on this path → None (distinct from an empty match).
    assert!(st.index_lookup("meta.zip", &n(1.0)).is_none());
}

/// Build an empty store, add two nodes and an edge, and read it all back —
/// hand-verified: ids 0 and 1, one out-edge 0→1 mirrored as an in-edge.
#[test]
fn add_nodes_and_edge_then_read_back() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("name", s("a"))]);
    let b = st.add_node(&["P"], &[("name", s("b"))]);
    assert_eq!((a, b), (0, 1));
    assert_eq!(st.node_count(), 2);
    st.add_edge(a, b, "R");
    assert_eq!(st.nodes_with_label("P"), &[0, 1]);
    assert_eq!(st.out(a).len(), 1);
    assert_eq!(st.out(a)[0].nbr, b);
    assert_eq!(st.inc(b)[0].nbr, a);
    assert_eq!(st.out(a)[0].eid, st.inc(b)[0].eid); // shared edge id
    assert!(matches!(st.prop(a, "name"), Value::Str(x) if &*x == "a"));
}

/// Adding a node AFTER a property column exists extends that column with an
/// absent slot: the old node keeps its value, the new node reads NULL.
#[test]
fn add_node_extends_existing_columns() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("age", n(30.0))]);
    let b = st.add_node(&["P"], &[]); // no age
    assert!(matches!(st.prop(a, "age"), Value::Num(x) if x == 30.0));
    assert!(st.prop(b, "age").is_null());
}

/// Writing a value of a different type promotes the column to `Gen`; both the
/// old-typed and new value read back correctly.
#[test]
fn set_prop_promotes_on_type_change() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("v", n(1.0))]);
    let b = st.add_node(&["P"], &[("v", n(2.0))]);
    st.set_prop(a, "v", s("two")); // Num column, Str value -> promote to Gen
    assert!(matches!(st.prop(a, "v"), Value::Str(x) if &*x == "two"));
    assert!(matches!(st.prop(b, "v"), Value::Num(x) if x == 2.0)); // preserved
}

/// `remove_prop` makes the property read NULL again; overwriting sets it.
#[test]
fn set_and_remove_prop() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("age", n(30.0))]);
    st.set_prop(a, "age", n(31.0));
    assert!(matches!(st.prop(a, "age"), Value::Num(x) if x == 31.0));
    st.remove_prop(a, "age");
    assert!(st.prop(a, "age").is_null());
}

/// A repeated edge type interns once (same `etype`) but each edge gets a
/// distinct `eid`. Ids continue after a `build()`-created edge.
#[test]
fn edge_type_interns_once_ids_unique() {
    let mut b = Builder::default();
    let x = b.node(&["P"], &[]);
    let y = b.node(&["P"], &[]);
    b.edge(x, y, "R"); // eid 0 at build
    let mut st = b.build();
    st.add_edge(x, y, "R"); // eid 1, same type
    st.add_edge(x, y, "S"); // eid 2, new type
    assert_eq!(st.out(x).len(), 3);
    let eids: Vec<u32> = st.out(x).iter().map(|a| a.eid).collect();
    assert_eq!(eids, vec![0, 1, 2]); // continued, unique
    assert_eq!(st.out(x)[0].etype, st.out(x)[1].etype); // R == R
    assert_ne!(st.out(x)[1].etype, st.out(x)[2].etype); // R != S
}

/// `delete_edge` removes the edge from both endpoints and is idempotent.
#[test]
fn delete_edge_detaches_both_sides() {
    let mut st = Builder::default().build();
    let a = st.add_node(&[], &[]);
    let b = st.add_node(&[], &[]);
    st.add_edge(a, b, "R");
    let eid = st.out(a)[0].eid;
    st.delete_edge(a, b, eid);
    assert!(st.out(a).is_empty());
    assert!(st.inc(b).is_empty());
    st.delete_edge(a, b, eid); // no-op the second time
    assert!(st.out(a).is_empty());
}

/// `delete_node` tombstones the node, detaches its edges from the neighbours'
/// mirror lists, clears its props, and drops it from scans. Hand-traced on
/// a→b, a→c, b→c: deleting b leaves a→c only, c with one incoming (from a).
#[test]
fn label_bucket_stays_sorted_through_delete_rollback() {
    let mut st = Builder::default().build();
    let ids: Vec<u32> = (0..6)
        .map(|i| st.add_node(&["P"], &[("age", n(f64::from(i)))]))
        .collect();
    st.create_index("age");
    // Delete a MIDDLE node in a transaction, then roll back (un-tombstone).
    st.begin();
    st.delete_node(ids[2]);
    st.rollback();
    // The label bucket must be sorted again — the restore re-inserts in place,
    // not appended — so the id-order scan seed and the binary-search label
    // intersection in `index_seek_ids` stay correct.
    let bucket = st.nodes_with_label("P");
    assert_eq!(bucket.len(), 6);
    assert!(
        bucket.windows(2).all(|w| w[0] < w[1]),
        "bucket not sorted after rollback: {bucket:?}"
    );
    // And the hash index still resolves the restored middle node.
    assert_eq!(st.index_lookup("age", &n(2.0)).unwrap(), vec![ids[2]]);
}

#[test]
fn delete_node_tombstones_and_cleans_up() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("name", s("a"))]);
    let b = st.add_node(&["P"], &[("name", s("b"))]);
    let c = st.add_node(&["P"], &[("name", s("c"))]);
    st.add_edge(a, b, "R");
    st.add_edge(a, c, "R");
    st.add_edge(b, c, "R");
    st.delete_node(b);

    assert!(!st.is_alive(b));
    assert_eq!(st.all_nodes(), vec![a, c]);
    assert_eq!(st.nodes_with_label("P"), &[a, c]); // b removed from bucket
    assert_eq!(st.out(a).len(), 1); // a→b gone, a→c stays
    assert_eq!(st.out(a)[0].nbr, c);
    assert_eq!(st.inc(c).len(), 1); // b→c gone, a→c stays
    assert_eq!(st.inc(c)[0].nbr, a);
    assert!(st.out(b).is_empty());
    assert!(st.prop(b, "name").is_null()); // props cleared
    assert!(!st.prop(a, "name").is_null()); // neighbour intact
    st.delete_node(b); // idempotent
    assert_eq!(st.all_nodes(), vec![a, c]);
}

/// A self-loop is detached without panicking when its node is deleted.
#[test]
fn delete_node_with_self_loop() {
    let mut st = Builder::default().build();
    let a = st.add_node(&[], &[]);
    st.add_edge(a, a, "R");
    st.delete_node(a);
    assert!(!st.is_alive(a));
    assert!(st.out(a).is_empty());
    assert!(st.inc(a).is_empty());
}

// --- Transactions ---

/// Commit keeps the changes; the log is discarded.
#[test]
fn commit_keeps_changes() {
    let mut st = Builder::default().build();
    st.begin();
    let a = st.add_node(&["P"], &[("name", s("a"))]);
    st.commit();
    assert_eq!(st.node_count(), 1);
    assert!(matches!(st.prop(a, "name"), Value::Str(x) if &*x == "a"));
}

/// Rolling back an `add_node` truly removes it: node_count returns to 0 and
/// the columns shrink back (not merely tombstoned).
#[test]
fn rollback_add_node_shrinks_back() {
    let mut st = Builder::default().build();
    st.begin();
    st.add_node(&["P"], &[("name", s("a"))]);
    st.add_node(&["P"], &[("name", s("b"))]);
    assert_eq!(st.node_count(), 2);
    st.rollback();
    assert_eq!(st.node_count(), 0);
    assert!(st.all_nodes().is_empty());
    assert!(st.nodes_with_label("P").is_empty());
}

/// Rolling back `set_prop` restores the exact prior cell (present value).
#[test]
fn rollback_set_prop_restores_value() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("age", n(30.0))]); // committed (autocommit)
    st.begin();
    st.set_prop(a, "age", n(99.0));
    st.set_prop(a, "age", s("oops")); // also promotes column to Gen
    assert!(matches!(st.prop(a, "age"), Value::Str(x) if &*x == "oops"));
    st.rollback();
    assert!(matches!(st.prop(a, "age"), Value::Num(x) if x == 30.0));
}

/// Rolling back a newly-set property (absent before) makes it absent again.
#[test]
fn rollback_new_prop_becomes_absent() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[]);
    st.begin();
    st.set_prop(a, "age", n(30.0));
    st.rollback();
    assert!(st.prop(a, "age").is_null());
    assert!(!st.has_prop(a, "age"));
}

/// Rolling back `add_edge` removes it from both endpoints.
#[test]
fn rollback_add_edge() {
    let mut st = Builder::default().build();
    let a = st.add_node(&[], &[]);
    let b = st.add_node(&[], &[]);
    st.begin();
    st.add_edge(a, b, "R");
    st.rollback();
    assert!(st.out(a).is_empty());
    assert!(st.inc(b).is_empty());
}

/// Rolling back `delete_node` restores it fully: tombstone, adjacency (its own
/// lists AND the neighbours' mirrors), label membership, and properties.
/// Hand-traced on a→b, b→c: delete b, then roll back → identical to before.
#[test]
fn rollback_delete_node_restores_everything() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("name", s("a"))]);
    let b = st.add_node(&["P"], &[("name", s("b"))]);
    let c = st.add_node(&["P"], &[("name", s("c"))]);
    st.add_edge(a, b, "R");
    st.add_edge(b, c, "R");
    st.begin();
    st.delete_node(b);
    assert!(!st.is_alive(b));
    st.rollback();

    assert!(st.is_alive(b));
    assert_eq!(st.nodes_with_label("P").len(), 3);
    assert!(matches!(st.prop(b, "name"), Value::Str(x) if &*x == "b"));
    // adjacency restored on all three nodes
    assert_eq!(st.out(a).len(), 1); // a→b
    assert_eq!(st.out(a)[0].nbr, b);
    assert_eq!(st.out(b).len(), 1); // b→c
    assert_eq!(st.out(b)[0].nbr, c);
    assert_eq!(st.inc(b).len(), 1); // a→b mirror
    assert_eq!(st.inc(c).len(), 1); // b→c mirror
}

/// `savepoint` + `rollback_to` give per-statement atomicity: the first
/// statement's writes survive, the second's are undone, the transaction stays
/// open, and the final commit keeps only the first.
#[test]
fn savepoint_rolls_back_one_statement() {
    let mut st = Builder::default().build();
    st.begin();
    let a = st.add_node(&["P"], &[("name", s("a"))]); // statement 1
    let mark = st.savepoint();
    let b = st.add_node(&["P"], &[("name", s("b"))]); // statement 2
    st.add_edge(a, b, "R");
    st.rollback_to(mark); // undo statement 2 only
    assert_eq!(st.node_count(), 1); // b popped
    assert!(st.out(a).is_empty()); // edge gone
    st.commit();
    assert_eq!(st.node_count(), 1);
    assert!(matches!(st.prop(a, "name"), Value::Str(x) if &*x == "a"));
}

// --- Edge properties ---

/// Set / read / remove an edge property, keyed by the edge's eid.
#[test]
fn edge_property_set_read_remove() {
    let mut st = Builder::default().build();
    let a = st.add_node(&[], &[]);
    let b = st.add_node(&[], &[]);
    st.add_edge(a, b, "R");
    let eid = st.out(a)[0].eid;
    assert!(st.edge_prop(eid, "weight").is_null()); // absent
    st.set_edge_prop(eid, "weight", n(0.5));
    assert!(st.has_edge_prop(eid, "weight"));
    assert!(matches!(st.edge_prop(eid, "weight"), Value::Num(x) if x == 0.5));
    st.remove_edge_prop(eid, "weight");
    assert!(!st.has_edge_prop(eid, "weight"));
    assert!(st.edge_prop(eid, "weight").is_null());
}

/// The numeric edge overlay tracks the boxed source of truth through every
/// mutation, and demotes a key that gains a non-numeric value.
#[test]
fn edge_num_overlay_tracks_boxed() {
    // Edges via the Builder (as the bench / from_ndjson do), so build() leaves the
    // overlay fresh and the incremental set-maintenance keeps it so.
    let mut b = Builder::default();
    let ids: Vec<u32> = (0..6).map(|_| b.node(&[], &[])).collect();
    for i in 0..5 {
        b.edge(ids[i], ids[i + 1], "R");
    }
    let mut st = b.build();
    let eids: Vec<u32> = (0..5).map(|i| st.out(i)[0].eid).collect();
    // Overlay agrees with edge_prop for every eid, for a numeric key.
    let agree = |st: &Store, key: &str| {
        let Some((data, present)) = st.edge_num_column(key) else {
            return None; // key not overlaid
        };
        for (idx, &eid) in eids.iter().enumerate() {
            let boxed = st.edge_prop(eid, key);
            let ov = if present[eid as usize] {
                Value::Num(data[eid as usize])
            } else {
                Value::Null
            };
            assert!(
                crate::value::equals(&boxed, &ov) || (boxed.is_null() && ov.is_null()),
                "overlay/boxed mismatch at eid {eid} (row {idx})"
            );
        }
        Some(())
    };
    for &eid in &eids {
        st.set_edge_prop(eid, "w", n(f64::from(eid) * 2.0));
    }
    assert!(
        agree(&st, "w").is_some(),
        "w should be overlaid after bulk set"
    );
    // Remove one, mutate another — overlay still agrees.
    st.remove_edge_prop(eids[1], "w");
    st.set_edge_prop(eids[2], "w", n(99.0));
    agree(&st, "w");
    // A non-numeric write demotes the key (readers fall back to boxed).
    st.set_edge_prop(eids[0], "w", s("hello"));
    assert!(
        st.edge_num_column("w").is_none(),
        "a Str value demotes the overlay"
    );
    assert!(matches!(st.edge_prop(eids[0], "w"), Value::Str(ref x) if &**x == "hello"));
    // A separate numeric key stays overlaid and correct.
    st.set_edge_prop(eids[3], "k", n(7.0));
    st.set_edge_prop(eids[4], "k", n(8.0));
    assert!(agree(&st, "k").is_some());
    // A fresh add_edge invalidates the overlay (eid space grew) → boxed fallback.
    st.add_edge(0, 2, "R");
    assert!(
        st.edge_num_column("k").is_none(),
        "add_edge invalidates the overlay"
    );
    assert!(matches!(st.edge_prop(eids[3], "k"), Value::Num(x) if x == 7.0));
    // boxed still right
}

/// An edge property write rolls back with the transaction.
#[test]
fn edge_property_rolls_back() {
    let mut st = Builder::default().build();
    let a = st.add_node(&[], &[]);
    let b = st.add_node(&[], &[]);
    st.add_edge(a, b, "R");
    let eid = st.out(a)[0].eid;
    st.set_edge_prop(eid, "weight", n(1.0)); // committed (autocommit)
    st.begin();
    st.set_edge_prop(eid, "weight", n(2.0));
    st.set_edge_prop(eid, "fresh", s("x"));
    st.rollback();
    assert!(matches!(st.edge_prop(eid, "weight"), Value::Num(x) if x == 1.0)); // restored
    assert!(!st.has_edge_prop(eid, "fresh")); // new key gone
}

// --- Unique constraints ---

/// A unique constraint on already-conforming data is accepted; check passes.
#[test]
fn unique_constraint_accepts_conforming_data() {
    let mut st = Builder::default().build();
    st.add_node(&["User"], &[("email", s("a@x"))]);
    st.add_node(&["User"], &[("email", s("b@x"))]);
    assert!(st.create_unique_constraint("User", &["email"]).is_ok());
    assert!(st.check_unique_for_label("User").is_ok());
}

/// Declaring a constraint the data already violates errors.
#[test]
fn unique_constraint_rejects_existing_duplicate() {
    let mut st = Builder::default().build();
    st.add_node(&["User"], &[("email", s("dup"))]);
    st.add_node(&["User"], &[("email", s("dup"))]);
    assert!(st.create_unique_constraint("User", &["email"]).is_err());
}

/// After a constraint, a duplicate added at the store level is detected by the
/// check (the store primitive itself stays infallible; enforcement is the
/// caller's, as the write statements do).
#[test]
fn unique_check_detects_new_duplicate() {
    let mut st = Builder::default().build();
    st.add_node(&["User"], &[("email", s("x"))]);
    st.create_unique_constraint("User", &["email"]).unwrap();
    st.add_node(&["User"], &[("email", s("x"))]); // primitive allows it
    assert!(st.check_unique_for_label("User").is_err()); // check catches it
}

/// Conflict-target inference: the constraint keys are returned when the
/// pattern's key set covers them.
#[test]
fn unique_keys_for_infers_target() {
    let mut st = Builder::default().build();
    st.create_unique_constraint("User", &["email"]).unwrap();
    assert_eq!(
        st.unique_keys_for("User", &["email".into(), "name".into()]),
        Some(vec!["email".into()])
    );
    assert_eq!(st.unique_keys_for("User", &["name".into()]), None);
    assert_eq!(st.unique_keys_for("Other", &["email".into()]), None);
}

/// `transaction` commits on `Ok` and rolls back on `Err`.
#[test]
fn transaction_commits_ok_rolls_back_err() {
    let mut st = Builder::default().build();
    let r: Result<u32, ()> = st.transaction(|s| Ok(s.add_node(&["P"], &[])));
    assert!(r.is_ok());
    assert_eq!(st.node_count(), 1);

    let r: Result<(), &str> = st.transaction(|s| {
        s.add_node(&["P"], &[]);
        Err("boom")
    });
    assert_eq!(r, Err("boom"));
    assert_eq!(st.node_count(), 1); // the aborted add was rolled back
}

// --- opt-in edge-type index (G5) ---

/// A small multi-type graph: node 0 knows 1 and likes 2; node 1 knows 2.
fn typed_graph() -> Store {
    let mut b = Builder::default();
    for _ in 0..3 {
        b.node(&["V"], &[]);
    }
    b.edge(0, 1, "KNOWS");
    b.edge(0, 2, "LIKES");
    b.edge(1, 2, "KNOWS");
    b.build()
}

/// The typed neighbours of `node` along `etype` (out), as a sorted id list.
fn out_ids(st: &Store, node: u32, ty: &str) -> Vec<u32> {
    let et = st.etype_id(ty).unwrap();
    let mut v: Vec<u32> = st.out_typed(node, et).iter().map(|a| a.nbr).collect();
    v.sort_unstable();
    v
}

/// The index, once built, agrees with a manual type-filter of the flat
/// adjacency for every node and type.
#[test]
fn edge_type_index_matches_flat_scan() {
    let mut st = typed_graph();
    st.create_edge_type_index();
    assert!(st.has_edge_type_index());
    for node in 0..st.node_count() as u32 {
        for ty in ["KNOWS", "LIKES"] {
            let et = st.etype_id(ty).unwrap();
            let mut scan: Vec<u32> = st
                .out(node)
                .iter()
                .filter(|a| a.etype == et)
                .map(|a| a.nbr)
                .collect();
            scan.sort_unstable();
            assert_eq!(out_ids(&st, node, ty), scan, "node {node} type {ty}");
        }
    }
    // node 0: KNOWS -> {1}, LIKES -> {2}
    assert_eq!(out_ids(&st, 0, "KNOWS"), vec![1]);
    assert_eq!(out_ids(&st, 0, "LIKES"), vec![2]);
}

/// add_edge keeps the index current (the O(1) hot path).
#[test]
fn edge_type_index_tracks_add() {
    let mut st = typed_graph();
    st.create_edge_type_index();
    st.add_edge(0, 2, "KNOWS");
    assert_eq!(out_ids(&st, 0, "KNOWS"), vec![1, 2]); // 0 now KNOWS 1 and 2
}

/// delete_edge and delete_node keep the index current, including neighbours'
/// incoming buckets.
#[test]
fn edge_type_index_tracks_delete() {
    let mut st = typed_graph();
    st.create_edge_type_index();
    let et = st.etype_id("KNOWS").unwrap();
    // delete 0-KNOWS->1: gone from 0's out bucket AND 1's in bucket.
    st.delete_edge(0, 1, 0);
    assert_eq!(out_ids(&st, 0, "KNOWS"), Vec::<u32>::new());
    let in1: Vec<u32> = st.in_typed(1, et).iter().map(|a| a.nbr).collect();
    assert_eq!(in1, Vec::<u32>::new());
    // delete node 2: removes 0-LIKES->2 and 1-KNOWS->2 mirrors.
    st.delete_node(2);
    assert_eq!(out_ids(&st, 0, "LIKES"), Vec::<u32>::new());
    assert_eq!(out_ids(&st, 1, "KNOWS"), Vec::<u32>::new());
}

/// Deleting a node removes exactly ONE entry from each neighbour's type bucket,
/// in the right DIRECTION, leaving the survivors in bucket order.
///
/// `edge_type_index_tracks_delete` cannot show this: every bucket it asserts on ends
/// up EMPTY, so a mutant that clears the whole bucket passes it, and `out_ids` sorts,
/// so one that scrambles the order passes too. Bucket order is observable — it is the
/// slice `out_typed` hands the traversal — so this reads the buckets RAW.
///
/// The fixture gives the hub a same-etype survivor on BOTH sides, which is what makes
/// "drop one" distinguishable from "drop all" and from "drop from the other direction"
/// (item 674; the same fixture blind spot as items 663 and 664).
#[test]
fn deleting_a_node_drops_one_type_bucket_entry_per_edge_and_keeps_the_order() {
    let mut b = Builder::default();
    for _ in 0..8 {
        b.node(&["V"], &[]);
    }
    // Hub 0's OUT/KNOWS bucket, in insertion order: [1, 2, 3, 4, 5].
    //
    // FIVE entries with the victim at index 1 is deliberate, and the first version of
    // this test got it wrong: with the bucket [1, 2, 3] a `swap_remove` moves the LAST
    // element into the gap and yields [1, 3] — exactly what `retain` gives, so the
    // order assertion was decorative and that mutant SURVIVED. At this length the two
    // part company: `retain` leaves [1, 3, 4, 5], `swap_remove` leaves [1, 5, 3, 4].
    b.edge(0, 1, "KNOWS");
    b.edge(0, 2, "KNOWS");
    b.edge(0, 3, "KNOWS");
    b.edge(0, 4, "KNOWS");
    b.edge(0, 5, "KNOWS");
    // Hub 0's IN/KNOWS bucket: [6, 7] — must be untouched by deleting 2.
    b.edge(6, 0, "KNOWS");
    b.edge(7, 0, "KNOWS");
    // A second etype on the hub whose only member is the victim: its key must go.
    b.edge(0, 2, "LIKES");
    // Victim 2 also has an OUT edge, so the `&out` detach loop is exercised too.
    b.edge(2, 3, "KNOWS");
    let mut st = b.build();
    st.create_edge_type_index();

    let knows = st.etype_id("KNOWS").unwrap();
    let likes = st.etype_id("LIKES").unwrap();
    let out_raw = |st: &Store, n: u32, et: u32| -> Vec<u32> {
        st.out_typed(n, et).iter().map(|a| a.nbr).collect()
    };
    let in_raw = |st: &Store, n: u32, et: u32| -> Vec<u32> {
        st.in_typed(n, et).iter().map(|a| a.nbr).collect()
    };

    assert_eq!(out_raw(&st, 0, knows), vec![1, 2, 3, 4, 5], "precondition");
    assert_eq!(in_raw(&st, 0, knows), vec![6, 7], "precondition");

    st.delete_node(2);

    // The entry at index 1 is gone and the survivors keep their relative order.
    // `swap_remove` would leave [1, 5, 3, 4] here, which this distinguishes.
    assert_eq!(
        out_raw(&st, 0, knows),
        vec![1, 3, 4, 5],
        "one dropped, order kept"
    );
    // The OTHER direction on the same node and etype is untouched.
    assert_eq!(in_raw(&st, 0, knows), vec![6, 7], "wrong-direction drop");
    // The etype whose only member was the victim is now absent, not merely empty.
    assert_eq!(out_raw(&st, 0, likes), Vec::<u32>::new());
    // The victim's own OUT edge was detached from node 3's IN bucket.
    assert_eq!(in_raw(&st, 3, knows), vec![0], "victim's out-edge mirror");
    // The victim's own buckets are empty.
    assert_eq!(out_raw(&st, 2, knows), Vec::<u32>::new());
    assert_eq!(in_raw(&st, 2, knows), Vec::<u32>::new());

    // And the index still agrees with a filter of the flat adjacency everywhere.
    for n in 0..st.node_count() as u32 {
        for et in [knows, likes] {
            let flat: Vec<u32> = st
                .out(n)
                .iter()
                .filter(|a| a.etype == et)
                .map(|a| a.nbr)
                .collect();
            assert_eq!(out_raw(&st, n, et), flat, "node {n} etype {et} out");
            let flat_in: Vec<u32> = st
                .inc(n)
                .iter()
                .filter(|a| a.etype == et)
                .map(|a| a.nbr)
                .collect();
            assert_eq!(in_raw(&st, n, et), flat_in, "node {n} etype {et} in");
        }
    }
}

/// `delete_edge` removes exactly ONE entry from each endpoint's type bucket and leaves
/// the survivors in bucket order.
///
/// The delete_node twin of this test explains the fixture; the same two blind spots apply
/// to `edge_type_index_tracks_delete`, which asserts only on buckets that end up EMPTY and
/// reads them through a SORTING helper. `delete_edge` is the hotter path of the two and is
/// also what `Undo::AddEdge` rolls back through (item 675).
#[test]
fn deleting_an_edge_drops_one_type_bucket_entry_and_keeps_the_order() {
    let mut b = Builder::default();
    for _ in 0..7 {
        b.node(&["V"], &[]);
    }
    // Hub 0's OUT/KNOWS bucket: [1, 2, 3, 4, 5]. Five with the victim at index 1, so
    // `retain` ([1,3,4,5]) and `swap_remove` ([1,5,3,4]) are distinguishable.
    b.edge(0, 1, "KNOWS");
    b.edge(0, 2, "KNOWS");
    b.edge(0, 3, "KNOWS");
    b.edge(0, 4, "KNOWS");
    b.edge(0, 5, "KNOWS");
    // Hub 0's IN/KNOWS bucket: [6] — must survive deleting an OUT edge.
    b.edge(6, 0, "KNOWS");
    let mut st = b.build();
    st.create_edge_type_index();

    let knows = st.etype_id("KNOWS").unwrap();
    let out_raw = |st: &Store, n: u32, et: u32| -> Vec<u32> {
        st.out_typed(n, et).iter().map(|a| a.nbr).collect()
    };
    let in_raw = |st: &Store, n: u32, et: u32| -> Vec<u32> {
        st.in_typed(n, et).iter().map(|a| a.nbr).collect()
    };

    assert_eq!(out_raw(&st, 0, knows), vec![1, 2, 3, 4, 5], "precondition");

    // Delete 0 -KNOWS-> 2, reading the eid off the adjacency rather than assuming it.
    let eid = st
        .out(0)
        .iter()
        .find(|a| a.nbr == 2)
        .expect("edge 0->2")
        .eid;
    st.delete_edge(0, 2, eid);

    assert_eq!(
        out_raw(&st, 0, knows),
        vec![1, 3, 4, 5],
        "one dropped, order kept"
    );
    // The other direction on the same node and etype is untouched.
    assert_eq!(in_raw(&st, 0, knows), vec![6], "wrong-direction drop");
    // And node 2's IN bucket lost its only entry.
    assert_eq!(in_raw(&st, 2, knows), Vec::<u32>::new());

    // Endpoint order is documented as irrelevant: deleting with the arguments SWAPPED
    // must work the same. 0 -KNOWS-> 3 via (3, 0).
    let eid3 = st
        .out(0)
        .iter()
        .find(|a| a.nbr == 3)
        .expect("edge 0->3")
        .eid;
    st.delete_edge(3, 0, eid3);
    assert_eq!(out_raw(&st, 0, knows), vec![1, 4, 5], "swapped endpoints");

    // The index still agrees with a filter of the flat adjacency everywhere.
    for n in 0..st.node_count() as u32 {
        let flat: Vec<u32> = st
            .out(n)
            .iter()
            .filter(|a| a.etype == knows)
            .map(|a| a.nbr)
            .collect();
        assert_eq!(out_raw(&st, n, knows), flat, "node {n} out");
        let flat_in: Vec<u32> = st
            .inc(n)
            .iter()
            .filter(|a| a.etype == knows)
            .map(|a| a.nbr)
            .collect();
        assert_eq!(in_raw(&st, n, knows), flat_in, "node {n} in");
    }
}

/// Transaction rollback restores the index exactly (a per-node rebuild off the
/// restored flat adjacency, so no delta bookkeeping can drift).
#[test]
fn edge_type_index_survives_rollback() {
    let mut st = typed_graph();
    st.create_edge_type_index();
    st.begin();
    st.add_edge(0, 2, "KNOWS"); // 0 KNOWS {1,2} inside the txn
    st.delete_edge(1, 2, 2); // 1 KNOWS {} inside the txn
    assert_eq!(out_ids(&st, 0, "KNOWS"), vec![1, 2]);
    st.rollback();
    // Back to the committed shape: 0 KNOWS {1}, 1 KNOWS {2}.
    assert_eq!(out_ids(&st, 0, "KNOWS"), vec![1]);
    assert_eq!(out_ids(&st, 1, "KNOWS"), vec![2]);
}

/// Rolling back a delete restores each type bucket to mirror the adjacency EXACTLY,
/// including the fact that a restore APPENDS rather than restoring position.
///
/// `edge_type_index_survives_rollback` cannot show this: its buckets are one or two
/// entries long and it reads them through the SORTING `out_ids` helper, so neither the
/// append order nor an over-eager rebuild is visible to it (item 676; the same blind spot
/// as items 674 and 675).
///
/// The load-bearing detail is that rollback does NOT undo the adjacency's ORDER. The
/// forward delete removes the entry from the middle and the restore pushes it back at the
/// END, so the adjacency ends up [1, 3, 4, 5, 2] — and the bucket has to match THAT, not
/// the original [1, 2, 3, 4, 5]. Asserting the pre-delete order here would be asserting a
/// property the engine does not have.
#[test]
fn rolling_back_a_delete_leaves_each_type_bucket_mirroring_the_adjacency() {
    let mut b = Builder::default();
    for _ in 0..7 {
        b.node(&["V"], &[]);
    }
    b.edge(0, 1, "KNOWS");
    b.edge(0, 2, "KNOWS");
    b.edge(0, 3, "KNOWS");
    b.edge(0, 4, "KNOWS");
    b.edge(0, 5, "KNOWS");
    b.edge(6, 0, "KNOWS");
    // The victim needs an OUTGOING edge of its own, or the `RestoreNode` branch that
    // re-pushes a mirror into a neighbour's IN bucket never runs and a mutant deleting
    // that branch is INERT rather than caught — which is exactly what happened on the
    // first mutation run for item 676.
    b.edge(2, 3, "KNOWS");
    let mut st = b.build();
    st.create_edge_type_index();

    let knows = st.etype_id("KNOWS").unwrap();
    let out_raw = |st: &Store, nd: u32| -> Vec<u32> {
        st.out_typed(nd, knows).iter().map(|a| a.nbr).collect()
    };
    let out_flat = |st: &Store, nd: u32| -> Vec<u32> {
        st.out(nd)
            .iter()
            .filter(|a| a.etype == knows)
            .map(|a| a.nbr)
            .collect()
    };
    let in_flat = |st: &Store, nd: u32| -> Vec<u32> {
        st.inc(nd)
            .iter()
            .filter(|a| a.etype == knows)
            .map(|a| a.nbr)
            .collect()
    };
    let agrees = |st: &Store, what: &str| {
        for nd in 0..st.node_count() as u32 {
            assert_eq!(out_raw(st, nd), out_flat(st, nd), "{what}: node {nd} out");
            let in_raw: Vec<u32> = st.in_typed(nd, knows).iter().map(|a| a.nbr).collect();
            assert_eq!(in_raw, in_flat(st, nd), "{what}: node {nd} in");
        }
    };

    // --- rolling back an EDGE delete ---
    let eid = st
        .out(0)
        .iter()
        .find(|a| a.nbr == 2)
        .expect("edge 0->2")
        .eid;
    st.begin();
    st.delete_edge(0, 2, eid);
    assert_eq!(out_raw(&st, 0), vec![1, 3, 4, 5], "inside the txn");
    st.rollback();

    // The restore APPENDS, so 2 comes back last — in both the adjacency and the bucket.
    assert_eq!(
        out_flat(&st, 0),
        vec![1, 3, 4, 5, 2],
        "adjacency after rollback"
    );
    assert_eq!(out_raw(&st, 0), vec![1, 3, 4, 5, 2], "bucket mirrors it");
    agrees(&st, "after edge-delete rollback");

    // --- rolling back a NODE delete ---
    // Deleting node 2 strips its mirror from hub 0's bucket; rolling back re-appends it.
    st.begin();
    st.delete_node(2);
    assert_eq!(out_raw(&st, 0), vec![1, 3, 4, 5], "inside the node txn");
    st.rollback();

    assert_eq!(
        out_raw(&st, 0),
        out_flat(&st, 0),
        "bucket mirrors adjacency"
    );
    assert!(out_raw(&st, 0).contains(&2), "node 2's edge is back");
    // Node 3's IN bucket regained the mirror of the victim's OUTGOING edge 2 -> 3.
    let in3: Vec<u32> = st.in_typed(3, knows).iter().map(|a| a.nbr).collect();
    assert!(
        in3.contains(&2),
        "victim's out-edge mirror restored on the neighbour"
    );
    assert_eq!(in3, in_flat(&st, 3), "and in adjacency order");
    agrees(&st, "after node-delete rollback");

    // Hub 0's IN bucket survived both round trips.
    let in0: Vec<u32> = st.in_typed(0, knows).iter().map(|a| a.nbr).collect();
    assert_eq!(in0, vec![6]);
}

/// A node added AFTER the index exists grows the index and indexes its edges.
#[test]
fn edge_type_index_grows_with_new_node() {
    let mut st = typed_graph();
    st.create_edge_type_index();
    let three = st.add_node(&["V"], &[]);
    st.add_edge(three, 0, "LIKES");
    assert_eq!(out_ids(&st, three, "LIKES"), vec![0]);
}

// --- opt-in edge interval index (G4) ---

/// One Emp node (0) with `degree` HELD edges to role node 1, edge d carrying
/// interval `[d, d+width]`.
fn interval_graph(degree: u32, width: i64) -> Store {
    let mut b = Builder::default();
    b.node(&["Emp"], &[]);
    b.node(&["Role"], &[]);
    let mut st = b.build();
    for d in 0..degree {
        let eid = st.add_edge(0, 1, "HELD");
        st.set_edge_prop(eid, "vf", n(f64::from(d)));
        st.set_edge_prop(eid, "vt", n((i64::from(d) + width) as f64));
    }
    st
}

/// Overlap eids from the index (sorted), vs a brute-force scan of the flat
/// adjacency reading the boxed props.
fn overlap_eids(st: &Store, node: u32, qlo: f64, qhi: f64) -> Vec<u32> {
    let mut v = Vec::new();
    st.for_each_overlap(node, qlo, qhi, |eid, _| v.push(eid));
    v.sort_unstable();
    v
}
fn overlap_bruteforce(st: &Store, node: u32, qlo: f64, qhi: f64) -> Vec<u32> {
    let mut v: Vec<u32> = st
        .out(node)
        .iter()
        .filter(|a| {
            matches!((st.edge_prop(a.eid, "vf"), st.edge_prop(a.eid, "vt")),
                    (Value::Num(lo), Value::Num(hi)) if lo <= qhi && hi >= qlo)
        })
        .map(|a| a.eid)
        .collect();
    v.sort_unstable();
    v
}

/// The seek agrees with a brute-force overlap scan for point queries across the
/// timeline AND for wider interval queries (both seed axes exercised).
#[test]
fn interval_seek_matches_bruteforce() {
    let st = {
        let mut s = interval_graph(64, 4);
        s.create_interval_index("vf", "vt");
        s
    };
    assert!(st.has_interval_index("vf", "vt"));
    // as-of points across the whole timeline (0..=67), incl. the ends where one
    // axis is far more selective than the other.
    for t in 0..=67 {
        let q = f64::from(t);
        assert_eq!(
            overlap_eids(&st, 0, q, q),
            overlap_bruteforce(&st, 0, q, q),
            "point t={t}"
        );
    }
    // wider ranges
    for &(lo, hi) in &[(10.0, 20.0), (0.0, 100.0), (63.0, 63.0), (-5.0, 2.0)] {
        assert_eq!(
            overlap_eids(&st, 0, lo, hi),
            overlap_bruteforce(&st, 0, lo, hi),
            "range [{lo},{hi}]"
        );
    }
}

/// Writes keep the interval index current: a new edge+interval appears, a
/// changed interval moves, a deleted edge vanishes.
#[test]
fn interval_index_tracks_writes() {
    let mut st = interval_graph(4, 2); // edges: [0,2],[1,3],[2,4],[3,5]
    st.create_interval_index("vf", "vt");
    // as-of t=10 → none.
    assert_eq!(overlap_eids(&st, 0, 10.0, 10.0), Vec::<u32>::new());
    // add an edge covering t=10.
    let e = st.add_edge(0, 1, "HELD");
    st.set_edge_prop(e, "vf", n(8.0));
    st.set_edge_prop(e, "vt", n(12.0));
    assert_eq!(overlap_eids(&st, 0, 10.0, 10.0), vec![e]);
    // move it off t=10.
    st.set_edge_prop(e, "vt", n(9.0));
    assert_eq!(overlap_eids(&st, 0, 10.0, 10.0), Vec::<u32>::new());
    // delete it.
    st.set_edge_prop(e, "vt", n(12.0));
    st.delete_edge(0, 1, e);
    assert_eq!(overlap_eids(&st, 0, 10.0, 10.0), Vec::<u32>::new());
}

/// Rollback restores the interval index exactly (a full rebuild against the
/// restored graph, so prop AND adjacency undo ordering can't drift it).
#[test]
fn interval_index_survives_rollback() {
    let mut st = interval_graph(4, 2);
    st.create_interval_index("vf", "vt");
    let before: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    st.begin();
    let e = st.add_edge(0, 1, "HELD");
    st.set_edge_prop(e, "vf", n(0.0));
    st.set_edge_prop(e, "vt", n(100.0)); // covers everything, inside the txn
    st.delete_edge(0, 1, 0); // and drop the first committed edge
    assert!(overlap_eids(&st, 0, 3.0, 3.0).contains(&e));
    st.rollback();
    let after: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(before, after);
}

/// Rolling back a transaction whose ONLY interval-relevant change is an edge property
/// under an interval key still leaves the index correct.
///
/// `interval_index_survives_rollback` cannot show this. It rolls back an `add_edge` and a
/// `delete_edge` as well as the prop writes, so the "did this transaction reach the
/// interval index?" test that now gates the rebuild (item 677) answers yes from the
/// ADJACENCY records alone — a version of that test which ignored edge-property keys
/// entirely would pass it. Here there is no adjacency change at all, so the edge-property
/// branch is the only thing that can trigger the rebuild.
#[test]
fn rolling_back_only_an_interval_prop_change_still_fixes_the_index() {
    let mut st = interval_graph(4, 2); // edges: [0,2],[1,3],[2,4],[3,5]
    st.create_interval_index("vf", "vt");

    let before: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();

    st.begin();
    // Move edge 0's interval far away — no adjacency change anywhere.
    st.set_edge_prop(0, "vf", n(900.0));
    st.set_edge_prop(0, "vt", n(999.0));
    assert!(
        !overlap_eids(&st, 0, 1.0, 1.0).contains(&0),
        "inside the txn the edge moved off t=1"
    );
    st.rollback();

    let after: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(
        before, after,
        "index stale after rolling back a prop-only txn"
    );

    // And the seek still agrees with a brute-force scan, which is the real invariant.
    for t in 0..8 {
        let q = f64::from(t);
        assert_eq!(
            overlap_eids(&st, 0, q, q),
            overlap_bruteforce(&st, 0, q, q),
            "t={t}"
        );
    }
}

/// Rolling back an ADJACENCY-only change still leaves the interval index correct.
///
/// The exact mirror of `rolling_back_only_an_interval_prop_change_still_fixes_the_index`,
/// and it closes the other half of the same hole: `interval_index_survives_rollback`
/// writes interval properties AND changes adjacency, so the gate added in item 677
/// answers "yes, this transaction reached the index" from the PROPERTY records alone — a
/// version that ignored adjacency entirely passed it. Here the transaction writes no
/// properties at all.
///
/// `Undo::RestoreEdge` and `Undo::RestoreNode` do NOT maintain the interval index as they
/// restore (unlike `Undo::AddEdge`, which routes through `delete_edge` and does), so they
/// genuinely depend on the rebuild.
#[test]
fn rolling_back_an_adjacency_only_change_still_fixes_the_interval_index() {
    let mut st = interval_graph(4, 2); // 4 HELD edges 0 -> 1, intervals [d, d+2]
    st.create_interval_index("vf", "vt");

    let before: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();

    // --- an edge DELETE, rolled back. No property writes anywhere in the txn.
    st.begin();
    st.delete_edge(0, 1, 0);
    assert!(
        !overlap_eids(&st, 0, 1.0, 1.0).contains(&0),
        "inside the txn edge 0 is gone"
    );
    st.rollback();

    let after: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(
        before, after,
        "index stale after an adjacency-only rollback"
    );

    for t in 0..8 {
        let q = f64::from(t);
        assert_eq!(
            overlap_eids(&st, 0, q, q),
            overlap_bruteforce(&st, 0, q, q),
            "after edge-delete rollback, t={t}"
        );
    }

    // --- a NODE delete, rolled back. Node 1 is the far end of every edge, so deleting
    // it strips node 0's whole interval index.
    st.begin();
    st.delete_node(1);
    st.rollback();

    let after_node: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(
        before, after_node,
        "index stale after a node-delete rollback"
    );

    for t in 0..8 {
        let q = f64::from(t);
        assert_eq!(
            overlap_eids(&st, 0, q, q),
            overlap_bruteforce(&st, 0, q, q),
            "after node-delete rollback, t={t}"
        );
    }
}

/// A transaction that touches the interval index must be detected even when an
/// IRRELEVANT change is the most recent record.
///
/// This pins that the gate asks "did ANY record reach the index", not "did the last one"
/// — a cheaper-looking check that would pass every other test here (item 677).
#[test]
fn an_irrelevant_last_write_does_not_hide_an_interval_change() {
    let mut st = interval_graph(4, 2);
    st.create_interval_index("vf", "vt");

    let before: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();

    st.begin();
    st.set_edge_prop(0, "vt", n(999.0)); // reaches the index
    st.set_prop(0, "unrelated", n(1.0)); // ... and is followed by one that does not
    st.add_label(0, "Tag");
    st.rollback();

    let after: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(before, after);
}

/// `rollback_to` gets the same treatment as `rollback`: undoing one failed statement
/// that touched the interval index leaves it correct.
#[test]
fn rolling_back_to_a_savepoint_fixes_the_interval_index() {
    let mut st = interval_graph(4, 2);
    st.create_interval_index("vf", "vt");

    st.begin();
    // A committed-within-the-txn change we intend to KEEP.
    let kept = st.add_edge(0, 1, "HELD");
    st.set_edge_prop(kept, "vf", n(0.0));
    st.set_edge_prop(kept, "vt", n(1.0));

    let mark = st.savepoint();
    let at_mark: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();

    // The failed statement: move an existing edge's interval, no adjacency change.
    st.set_edge_prop(0, "vf", n(900.0));
    st.set_edge_prop(0, "vt", n(999.0));
    st.rollback_to(mark);

    let after: Vec<Vec<u32>> = (0..8)
        .map(|t| overlap_eids(&st, 0, f64::from(t), f64::from(t)))
        .collect();
    assert_eq!(at_mark, after, "index stale after rollback_to");

    for t in 0..8 {
        let q = f64::from(t);
        assert_eq!(
            overlap_eids(&st, 0, q, q),
            overlap_bruteforce(&st, 0, q, q),
            "t={t}"
        );
    }

    // The kept change really was kept.
    st.commit();
    assert!(overlap_eids(&st, 0, 0.0, 0.0).contains(&kept));
}

/// Updating an edge's interval property must cost the same whether the graph has 2k
/// or 32k nodes — the index is source-partitioned, so only the edge's source node is
/// reindexed. Guards against the O(V+E) full `rebuild_interval` this path used to do
/// on every write (a bitemporal workload that hot-updates edge validity intervals
/// would otherwise repack the whole index per write). Timing/scaling guard, so MIN
/// over reps and `#[ignore]`d — run isolated in release:
///   cargo test -p lenke-engine --release --lib \
///     interval_edge_write_is_independent_of_graph_size -- --ignored
#[test]
#[ignore = "timing/scaling guard — run isolated in release (see doc comment)"]
fn interval_edge_write_is_independent_of_graph_size() {
    use std::time::Instant;

    const REPS: usize = 9;

    // A graph of `nnodes` where node 0 has a FIXED small out-degree of interval
    // edges. The source degree (what an incremental reindex touches) is constant, so
    // only a full-index rebuild would make the write scale with `nnodes`.
    let build = |nnodes: u32| -> (Store, u32) {
        let mut b = Builder::default();
        for _ in 0..nnodes {
            b.node(&["P"], &[]);
        }
        let mut st = b.build();
        st.create_interval_index("vf", "vt");
        let mut first = 0;
        for d in 0..4u32 {
            let eid = st.add_edge(0, (d + 1) % nnodes, "HELD");
            st.set_edge_prop(eid, "vf", n(f64::from(d)));
            st.set_edge_prop(eid, "vt", n(f64::from(d) + 10.0));
            if d == 0 {
                first = eid;
            }
        }
        (st, first)
    };
    let time = |st: &mut Store, eid: u32| {
        for i in 0..20 {
            st.set_edge_prop(eid, "vt", n(f64::from(i) + 10.0)); // warm up
        }
        let mut best = f64::INFINITY;
        for _ in 0..REPS {
            let t = Instant::now();
            for i in 0..100 {
                st.set_edge_prop(eid, "vt", n(f64::from(i) + 10.0));
            }
            best = best.min(t.elapsed().as_secs_f64());
        }
        best
    };

    let (mut small_st, e_small) = build(2_000);
    let small = time(&mut small_st, e_small);
    let (mut large_st, e_large) = build(32_000);
    let large = time(&mut large_st, e_large);

    let ratio = large / small.max(f64::MIN_POSITIVE);
    assert!(
        ratio < 6.0,
        "interval-key edge write scaled with graph size: 16x more nodes cost {ratio:.1}x \
             more time ({small:.5}s -> {large:.5}s, min of {REPS}). `set_edge_prop` is \
             rebuilding the whole interval index instead of reindexing the edge's source node."
    );
}

// --- type / cardinality / edge / drop-index constraints ---------------

#[test]
fn type_constraint_enforced_on_write() {
    let mut st = Store::default();
    assert!(st
        .create_type_constraint("P", "age", "number", false)
        .is_ok());
    st.begin();
    st.add_node(&["P"], &[("age", Value::Str("old".into()))]);
    assert!(
        st.run_deferred_checks().is_err(),
        "string age violates number"
    );
    st.rollback();
    st.begin();
    st.add_node(&["P"], &[("age", n(42.0))]);
    assert!(st.run_deferred_checks().is_ok());
    st.commit();
}

#[test]
fn type_constraint_unknown_name_is_invalid_value() {
    let mut st = Store::default();
    let e = st
        .create_type_constraint("P", "age", "bogus", false)
        .unwrap_err();
    assert!(e.starts_with("E_INVALID_VALUE"), "{e}");
}

#[test]
fn not_null_type_constraint_rejects_absent_and_null() {
    let mut st = Store::default();
    st.create_type_constraint("P", "name", "string NOT NULL", false)
        .unwrap();
    for missing in [vec![], vec![("name", Value::Null)]] {
        st.begin();
        st.add_node(&["P"], &missing);
        assert!(st.run_deferred_checks().is_err(), "NOT NULL must reject");
        st.rollback();
    }
    st.begin();
    st.add_node(&["P"], &[("name", Value::Str("ann".into()))]);
    assert!(st.run_deferred_checks().is_ok());
    st.commit();
}

#[test]
fn cardinality_min_and_max_enforced() {
    let mut st = Store::default();
    // out-degree of KNOWS must be exactly 1.
    st.create_cardinality_constraint("P", "KNOWS", 0, 1, Some(1))
        .unwrap();
    st.begin();
    st.add_node(&["P"], &[]); // 0 edges → below min
    assert!(st.run_deferred_checks().is_err());
    st.rollback();
    st.begin();
    let a = st.add_node(&["P"], &[]);
    let b = st.add_node(&["T"], &[]);
    let c = st.add_node(&["T"], &[]);
    st.add_edge(a, b, "KNOWS");
    st.add_edge(a, c, "KNOWS"); // out-degree 2 → above max
    assert!(st.run_deferred_checks().is_err());
    st.rollback();
    st.begin();
    let a = st.add_node(&["P"], &[]);
    let b = st.add_node(&["T"], &[]);
    st.add_edge(a, b, "KNOWS"); // exactly 1
    assert!(st.run_deferred_checks().is_ok());
    st.commit();
}

#[test]
fn edge_unique_enforced_and_null_exempt() {
    let mut st = Store::default();
    st.create_edge_unique_constraint("PAID", &["ref"]).unwrap();
    st.begin();
    let a = st.add_node(&["A"], &[]);
    let b = st.add_node(&["A"], &[]);
    let e1 = st.add_edge(a, b, "PAID");
    st.set_edge_prop(e1, "ref", Value::Str("x".into()));
    let e2 = st.add_edge(a, b, "PAID");
    st.set_edge_prop(e2, "ref", Value::Str("x".into())); // duplicate
    assert!(st.run_deferred_checks().is_err());
    st.rollback();
    // Two edges with an absent `ref` are exempt (nulls don't collide).
    st.begin();
    let a = st.add_node(&["A"], &[]);
    let b = st.add_node(&["A"], &[]);
    st.add_edge(a, b, "PAID");
    st.add_edge(a, b, "PAID");
    assert!(st.run_deferred_checks().is_ok());
    st.commit();
}

#[test]
fn edge_required_enforced_on_write() {
    let mut st = Store::default();
    st.create_edge_required_constraint("PAID", "amt").unwrap();
    st.begin();
    let a = st.add_node(&["A"], &[]);
    let b = st.add_node(&["A"], &[]);
    st.add_edge(a, b, "PAID"); // missing amt
    assert!(st.run_deferred_checks().is_err());
    st.rollback();
}

#[test]
fn drop_index_removes_and_guards_a_backing_unique() {
    let mut st = Store::default();
    st.add_node(&["P"], &[("age", n(1.0))]);
    st.create_index("age");
    assert!(st.has_hash_index("age"));
    assert!(st.drop_vertex_index("age").is_ok());
    assert!(!st.has_hash_index("age"));
    assert!(st.drop_vertex_index("age").is_ok(), "drop is idempotent");
    // Dropping the index behind a unique constraint is rejected.
    st.create_index("email");
    st.create_unique_constraint("P", &["email"]).unwrap();
    let e = st.drop_vertex_index("email").unwrap_err();
    assert!(e.starts_with("E_INVALID_GRAPH_OP"), "{e}");
}

#[test]
fn declaring_a_constraint_the_data_breaks_is_rejected() {
    let mut st = Store::default();
    st.add_node(&["P"], &[("age", Value::Str("nope".into()))]);
    let e = st
        .create_type_constraint("P", "age", "number", false)
        .unwrap_err();
    assert!(e.starts_with("E_TYPE"), "{e}");
}

/// A CLOSED record type: field types + NOT NULL fields + closed-on-extras, with
/// a nested record. A node whose `m` is a matching record accepts the constraint;
/// each way of breaking the shape rejects it.
#[test]
fn closed_record_type_constraint() {
    let spec = "record{a::number,b::string NOT NULL,c::record{d::boolean}}";
    // `m` built from a nested JSON object → a canonical Value::Record.
    let node = |m: &str| {
        crate::ndjson::from_ndjson(&format!(
            "{{\"id\":\"a\",\"labels\":[\"P\"],\"props\":{{\"m\":{m}}}}}\n"
        ))
        .unwrap()
    };
    let declare = |mut st: Store| st.create_type_constraint("P", "m", spec, false);

    // Conforming (optional `a`/`c` omitted; required `b` present; nested ok).
    assert!(declare(node(r#"{"b":"x"}"#)).is_ok());
    assert!(declare(node(r#"{"a":1,"b":"x","c":{"d":true}}"#)).is_ok());
    // Wrong scalar field type.
    assert!(declare(node(r#"{"a":"nope","b":"x"}"#)).is_err());
    // Missing a NOT NULL field.
    assert!(declare(node(r#"{"a":1}"#)).is_err());
    // Extra field (closed on extras).
    assert!(declare(node(r#"{"b":"x","z":2}"#)).is_err());
    // Nested field wrong type.
    assert!(declare(node(r#"{"b":"x","c":{"d":5}}"#)).is_err());
    // A null property is exempt (the property is nullable without NOT NULL).
    assert!(declare(node("null")).is_ok());
    // A non-record value violates a record type.
    assert!(declare(node("42")).is_err());
}

#[test]
fn any_record_type_constraint() {
    let node = |m: &str| {
        crate::ndjson::from_ndjson(&format!(
            "{{\"id\":\"a\",\"labels\":[\"P\"],\"props\":{{\"m\":{m}}}}}\n"
        ))
        .unwrap()
    };
    // `any record` accepts any record shape but rejects a scalar.
    assert!(node(r#"{"anything":1,"here":true}"#)
        .create_type_constraint("P", "m", "any record", false)
        .is_ok());
    assert!(node("42")
        .create_type_constraint("P", "m", "any record", false)
        .is_err());
}

#[test]
fn record_type_name_round_trips() {
    // A declared record type dumps a spec that parses back to the same rule.
    let mut st = crate::ndjson::from_ndjson(
        "{\"id\":\"a\",\"labels\":[\"P\"],\"props\":{\"m\":{\"a\":1,\"b\":\"x\"}}}\n",
    )
    .unwrap();
    let spec = "record{a::number,b::string NOT NULL}";
    st.create_type_constraint("P", "m", spec, false).unwrap();
    let (_, _, dumped, _) = st.type_constraints().into_iter().next().unwrap();
    // Re-declaring from the dumped name succeeds on the same data (round-trips).
    let mut st2 = crate::ndjson::from_ndjson(
        "{\"id\":\"a\",\"labels\":[\"P\"],\"props\":{\"m\":{\"a\":1,\"b\":\"x\"}}}\n",
    )
    .unwrap();
    assert!(
        st2.create_type_constraint("P", "m", &dumped, false).is_ok(),
        "dumped: {dumped}"
    );
}

#[test]
fn dict_max_distinct_knob_gates_high_cardinality_encoding() {
    let mk = || {
        // 5000 distinct city values, each appearing 3× (15000 rows): repeats heavily,
        // but distinct > the default 4096 dict cap.
        let mut s = Store::default();
        for i in 0..15_000u32 {
            let v = Value::Str(format!("city-{:05}", i % 5000).as_str().into());
            s.add_node(&["P"], &[("city", v)]);
        }
        s
    };
    // Default cap (4096): too many distinct → stays a plain Str column.
    let mut a = mk();
    a.dict_encode_columns();
    assert!(
        matches!(a.column("city"), Some(Column::Str { .. })),
        "default cap leaves it Str"
    );

    // Raised cap: the genuinely-repeating column now dictionary-encodes.
    let mut b = mk();
    b.set_limit(ConfigId::LimitsDictMaxDistinct, 8192);
    b.dict_encode_columns();
    assert!(
        matches!(b.column("city"), Some(Column::Dict { .. })),
        "raised cap admits the repeated column"
    );

    // A truly-unique column is NEVER encoded, even with a huge cap — the ≥2× repetition
    // guard protects against the user forcing the pathological case.
    let mut c = Store::default();
    for i in 0..10_000u32 {
        c.add_node(
            &["P"],
            &[("uid", Value::Str(format!("uid-{i}").as_str().into()))],
        );
    }
    c.set_limit(ConfigId::LimitsDictMaxDistinct, 1_000_000);
    c.dict_encode_columns();
    assert!(
        matches!(c.column("uid"), Some(Column::Str { .. })),
        "unique column stays Str despite the cap"
    );
}

#[test]
fn validate_label_rejects_empty_and_double_colon() {
    assert!(validate_label("Person").is_ok());
    assert!(validate_label("").unwrap_err().contains("non-empty"));
    let err = validate_label("a::b").unwrap_err();
    assert!(
        err.contains("::") && err.contains("E_INVALID_VALUE"),
        "{err}"
    );
}

#[test]
fn validate_prop_key_rejects_empty() {
    assert!(validate_prop_key("name").is_ok());
    assert!(validate_prop_key("").unwrap_err().contains("non-empty"));
}

#[test]
fn ndjson_ingest_rejects_malformed_names() {
    // The engine must refuse the names the TS Graph refuses at deserialize, so the two
    // engines accept/reject the same document (and a `::` label cannot silently corrupt
    // a later graphson encode).
    for nd in [
        r#"{"type":"node","id":"x","labels":["a::b"],"properties":{}}"#,
        r#"{"type":"node","id":"x","labels":[""],"properties":{}}"#,
        r#"{"type":"node","id":"x","labels":["N"],"properties":{"":1}}"#,
    ] {
        let err = match crate::ndjson::from_ndjson(nd) {
            Ok(_) => panic!("expected rejection for `{nd}`"),
            Err(e) => e,
        };
        assert!(
            err.contains("E_INVALID_VALUE"),
            "expected rejection, got: {err}"
        );
    }
    // A well-formed document still loads.
    assert!(crate::ndjson::from_ndjson(
        r#"{"type":"node","id":"x","labels":["N"],"properties":{"k":1}}"#
    )
    .is_ok());
}

#[test]
fn rollback_restores_version_and_epoch_but_commit_advances_them() {
    // A rolled-back transaction is observed to have changed nothing, so the reactive
    // counters (`version`, per-token `epoch`) must return to their pre-tx values — the
    // undo replay re-touches every reverted cell and would otherwise leave them advanced,
    // spuriously invalidating every subscriber. A COMMITTED tx still advances them.
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("k", n(1.0))]);

    let v0 = st.version();
    let e0 = st.epoch("k");

    // Rolled back → counters unchanged.
    st.begin();
    st.set_prop(a, "k", n(2.0));
    assert!(st.version() > v0, "forward write advances version mid-tx");
    st.rollback();
    assert_eq!(st.version(), v0, "version restored after rollback");
    assert_eq!(st.epoch("k"), e0, "epoch restored after rollback");
    assert!(
        crate::value::equals(&st.prop(a, "k"), &n(1.0)),
        "value restored"
    );

    // Committed → counters advance.
    st.begin();
    st.set_prop(a, "k", n(3.0));
    st.commit();
    assert!(st.version() > v0, "version advances after commit");
    assert!(st.epoch("k") > e0, "epoch advances after commit");
}

#[test]
fn rollback_reverts_schema_created_in_a_transaction() {
    // A schema op (index / constraint) declared inside a transaction must revert with the
    // rest of the transaction — `apply_schema_op` captures the declarative schema on the
    // first op (simulated here by calling `snapshot_schema_for_tx` directly).
    let mut st = Builder::default().build();
    st.add_node(&["N"], &[("k", n(1.0))]);

    // Created-then-rolled-back → gone.
    st.begin();
    st.snapshot_schema_for_tx();
    st.create_index("k");
    st.create_unique_constraint("N", &["k"]).unwrap();
    assert!(
        st.hash_index_keys().contains(&"k".to_string()),
        "index exists mid-tx"
    );
    assert_eq!(st.unique_constraints().len(), 1, "constraint exists mid-tx");
    st.rollback();
    assert!(
        st.hash_index_keys().is_empty(),
        "created index reverted on rollback"
    );
    assert!(
        st.unique_constraints().is_empty(),
        "created constraint reverted on rollback"
    );

    // Created-then-committed → stays.
    st.begin();
    st.snapshot_schema_for_tx();
    st.create_index("k");
    st.commit();
    assert!(
        st.hash_index_keys().contains(&"k".to_string()),
        "committed index stays"
    );

    // A PRE-EXISTING index is untouched by a rolled-back tx that also declares new schema.
    st.begin();
    st.snapshot_schema_for_tx();
    st.create_unique_constraint("N", &["k"]).unwrap();
    st.rollback();
    assert!(
        st.hash_index_keys().contains(&"k".to_string()),
        "pre-existing index survives"
    );
    assert!(
        st.unique_constraints().is_empty(),
        "tx-created constraint reverted"
    );
}

/// `live_node_count` is now an O(1) read of a maintained counter rather than a sweep of
/// the tombstone bitmap, because the row evaluator's `hasLabel` asks per ROW (spotting a
/// label that covers the whole graph) and a 100k-bool scan there cost 3us a call.
///
/// A cached counter is wrong the moment a write path forgets to maintain it, so this
/// walks the reachable write paths and compares the cache against a fresh recount after
/// each step. What it actually pins, verified by mutation: the UNSET on rollback of a
/// delete (dropping that decrement turns this test red). Two other sites cannot be
/// reached — `delete_node` early-returns on an already-deleted node, so the increment
/// there is unconditional, and undo replay clears a tombstone before the matching pop, so
/// the pop never sees one. Both are noted at their sites rather than guarded blindly.
#[test]
fn the_cached_live_node_count_tracks_every_tombstone_write() {
    let mut s = Store::default();
    let check = |s: &Store, expect: usize, at: &str| {
        assert_eq!(s.live_node_count(), expect, "live count at {at}");
        assert_eq!(
            s.live_node_count(),
            s.recount_live_nodes(),
            "cache disagreed with the bitmap at {at}"
        );
    };
    check(&s, 0, "empty");

    let a = s.add_node(&["N"], &[]);
    let b = s.add_node(&["N"], &[]);
    let c = s.add_node(&["N"], &[]);
    check(&s, 3, "three added");

    s.delete_node(b);
    check(&s, 2, "one deleted");
    // Deleting twice is a no-op (an early return), so the count must not move.
    s.delete_node(b);
    check(&s, 2, "deleted again");

    // A ROLLED-BACK delete restores the node, which unsets a tombstone.
    s.begin();
    s.delete_node(a);
    check(&s, 1, "inside the tx");
    s.rollback();
    check(&s, 2, "after rollback of a delete");

    // A ROLLED-BACK insert pops a slot off the bitmap.
    s.begin();
    let d = s.add_node(&["N"], &[]);
    check(&s, 3, "inside the tx, one added");
    s.rollback();
    check(&s, 2, "after rollback of an insert");

    // And a rolled-back insert of a node that was then deleted in the same tx: the pop
    // removes a slot whose tombstone was SET, so the counter has to come back down.
    s.begin();
    let e = s.add_node(&["N"], &[]);
    s.delete_node(e);
    check(&s, 2, "added then deleted inside the tx");
    s.rollback();
    check(&s, 2, "after rollback of add-then-delete");

    // Committed work keeps the count.
    s.begin();
    s.delete_node(c);
    s.commit();
    check(&s, 1, "after a committed delete");
    let _ = (d, e);
}

/// `index_distinct_count` is `count(DISTINCT key)` in O(1), and it is EXACT — which is what audit
/// item 367 had to fix. `index_drop_node` already pruned the deleted id from its bucket, but the
/// emptied bucket kept its KEY, so the map's key count over-reported: a value no live node carries
/// any more still occupied an entry. An over-estimate is a WRONG count, not a slow one, and that is
/// why the distinct count this map obviously holds could not be used as an answer.
///
/// Every assertion below is on a value whose holders are ALL deleted — the only case where the
/// pruning is observable. Without it the counts read 3, 3, 3 instead of 2, 1, 1.
#[test]
fn an_index_distinct_count_is_exact_after_deletes() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("city", s("NYC"))]);
    let b = st.add_node(&["P"], &[("city", s("LA"))]);
    let c = st.add_node(&["P"], &[("city", s("NYC"))]);
    let d = st.add_node(&["P"], &[("city", s("SF"))]);

    st.create_index("city");

    assert_eq!(st.index_distinct_count("city"), Some(3), "NYC, LA, SF");
    assert_eq!(st.index_distinct_count("nosuch"), None, "no index on it");

    // One of TWO holders of NYC: the value survives, so the count must not move.
    st.delete_node(a);
    assert_eq!(
        st.index_distinct_count("city"),
        Some(3),
        "NYC still has a holder"
    );

    // The LAST holder of NYC: now the value is gone and the count must drop.
    st.delete_node(c);
    assert_eq!(
        st.index_distinct_count("city"),
        Some(2),
        "NYC has no live holder left"
    );

    st.delete_node(b);
    assert_eq!(st.index_distinct_count("city"), Some(1), "only SF remains");

    st.delete_node(d);
    assert_eq!(
        st.index_distinct_count("city"),
        Some(0),
        "an index over no live nodes holds no values"
    );

    // And the pruning must not break the LOOKUP: a seek for a value whose holders are gone
    // answers empty, not stale ids, and a surviving value still resolves.
    let mut st2 = Builder::default().build();
    let x = st2.add_node(&["P"], &[("city", s("NYC"))]);
    let y = st2.add_node(&["P"], &[("city", s("LA"))]);

    st2.create_index("city");
    st2.delete_node(x);

    assert_eq!(
        st2.index_lookup("city", &s("NYC")),
        Some(vec![]),
        "the index still EXISTS for a pruned value — Some(empty), never None"
    );
    assert_eq!(st2.index_lookup("city", &s("LA")), Some(vec![y]));
    assert_eq!(st2.index_distinct_count("city"), Some(1));
}

/// The dotted-path twin, because a dotted index keys on a descended value and the pruning runs
/// through the same `removals` loop — and because every node/edge-shaped asymmetry in this repo was
/// found by testing the twin (items 333, 335, 349).
#[test]
fn a_dotted_index_distinct_count_is_exact_after_deletes() {
    use crate::value::make_record;
    let city = |c: &str| make_record(vec![(crate::gstr::GStr::from("city"), s(c))]);
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("meta", city("NYC"))]);
    let b = st.add_node(&["P"], &[("meta", city("LA"))]);

    st.create_index("meta.city");

    assert_eq!(st.index_distinct_count("meta.city"), Some(2));

    st.delete_node(a);

    assert_eq!(
        st.index_distinct_count("meta.city"),
        Some(1),
        "the dotted path prunes its emptied bucket too"
    );
    assert_eq!(st.index_lookup("meta.city", &s("LA")), Some(vec![b]));
}

/// A NULL is NOT in a hash index, so `index_distinct_count` excludes it — which is exactly what
/// `count(DISTINCT x)` wants, since ISO/SQL `count` ignores nulls.
///
/// Item 367's doc comment asserted the OPPOSITE ("a stored NULL has its own group key and so counts
/// as a distinct value") and recorded it as a precondition the caller would have to handle. That was
/// wrong: `apply_set_prop` says so in its own comment — *"A NULL is never seek-indexed
/// (`WHERE k = null` matches nothing), so it is excluded from both indexes"*. This test is why the
/// claim is now checked rather than reasoned, and it is what would catch a change to that policy.
#[test]
fn a_null_is_not_a_distinct_indexed_value() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("city", s("NYC"))]);
    let _b = st.add_node(&["P"], &[("city", Value::Null)]);
    let _c = st.add_node(&["P"], &[]); // absent, not null

    st.create_index("city");

    assert_eq!(
        st.index_distinct_count("city"),
        Some(1),
        "only NYC: a present-null and an absent property are both out of the index"
    );
    assert_eq!(
        st.index_lookup("city", &Value::Null),
        Some(vec![]),
        "`WHERE city = null` matches nothing, so the null holder is in no bucket"
    );

    // And a SET to null REMOVES the old indexed value rather than re-keying it.
    st.set_prop(a, "city", Value::Null);

    assert_eq!(
        st.index_distinct_count("city"),
        Some(0),
        "setting the last non-null value to null empties the index"
    );
}

/// The SET twin of `an_index_distinct_count_is_exact_after_deletes`: a node whose indexed value
/// CHANGES leaves its old value behind with an empty bucket, exactly as a deleted one did.
///
/// Item 367 pruned the DELETE path and missed this one. Written because the null test above only
/// exercises set-to-NULL, which takes `reindex_node`'s `new: None` arm — a value-to-value update
/// takes the other arm, and that is the common case.
#[test]
fn an_index_distinct_count_is_exact_after_updates() {
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("city", s("NYC"))]);
    let b = st.add_node(&["P"], &[("city", s("NYC"))]);
    let _c = st.add_node(&["P"], &[("city", s("LA"))]);

    st.create_index("city");

    assert_eq!(st.index_distinct_count("city"), Some(2), "NYC, LA");

    // One of two NYC holders moves to LA: NYC survives, so the count must not move.
    st.set_prop(a, "city", s("LA"));
    assert_eq!(
        st.index_distinct_count("city"),
        Some(2),
        "NYC still has a holder"
    );

    // The LAST NYC holder moves: the value is gone and the count must drop.
    st.set_prop(b, "city", s("LA"));
    assert_eq!(
        st.index_distinct_count("city"),
        Some(1),
        "only LA remains after the last NYC holder moved"
    );

    // ...and the seek must agree: NYC resolves to nothing, LA to all three.
    assert_eq!(st.index_lookup("city", &s("NYC")), Some(vec![]));

    let mut la = st.index_lookup("city", &s("LA")).expect("indexed");

    la.sort_unstable();

    assert_eq!(la.len(), 3, "every node moved to LA");

    // A brand-new value re-creates its key.
    st.set_prop(a, "city", s("SF"));
    assert_eq!(st.index_distinct_count("city"), Some(2), "LA and SF");
}

/// `range_min_max` is the live minimum and maximum in O(log n) — and it is EXACT only because
/// `range_remove` drops an emptied bucket's KEY (audit item 370, the RANGE twin of 367/368).
///
/// This matters more than the hash case did. A stale hash key inflated a distinct COUNT; a stale
/// range key is an ORDERED POSITION, so the map's first and last keys stop being the live extremes.
/// Every assertion below removes the current extreme, which is the only observable case.
#[test]
fn a_range_min_max_is_exact_after_deletes_and_updates() {
    let n = |x: f64| Value::Num(x);
    let mut st = Builder::default().build();
    let a = st.add_node(&["P"], &[("age", n(10.0))]);
    let b = st.add_node(&["P"], &[("age", n(50.0))]);
    let c = st.add_node(&["P"], &[("age", n(99.0))]);
    let d = st.add_node(&["P"], &[("age", n(50.0))]);

    st.create_range_index("age");

    let got = |s: &crate::store::Store| format!("{:?}", s.range_min_max("age"));

    assert_eq!(got(&st), "Some((Num(10.0), Num(99.0)))");
    assert_eq!(
        st.range_min_max("nosuch").map(|_| ()),
        None,
        "no range index on it"
    );

    // Delete the MINIMUM holder: the min must advance.
    st.delete_node(a);
    assert_eq!(
        got(&st),
        "Some((Num(50.0), Num(99.0)))",
        "10 has no live holder"
    );

    // Delete the MAXIMUM holder: the max must retreat.
    st.delete_node(c);
    assert_eq!(
        got(&st),
        "Some((Num(50.0), Num(50.0)))",
        "99 has no live holder"
    );

    // One of TWO holders of 50: the value survives, so nothing moves.
    st.delete_node(b);
    assert_eq!(got(&st), "Some((Num(50.0), Num(50.0)))", "d still holds 50");

    // UPDATE the last holder away: the SET path routes through the same `range_remove`, so this
    // is the twin assertion rather than a separate mechanism.
    st.set_prop(d, "age", n(7.0));
    assert_eq!(
        got(&st),
        "Some((Num(7.0), Num(7.0)))",
        "the only live value is 7"
    );

    // ...and a SET to NULL leaves the index empty, since a null never enters a range index.
    st.set_prop(d, "age", Value::Null);
    assert_eq!(got(&st), "None", "no values left");
}

/// Item 443: `delete_nodes` sweeps each label bucket ONCE for a batch, where `delete_node` used
/// to sweep every bucket per node — which made `MATCH (a:P) DETACH DELETE a` O(deleted x total
/// nodes) (item 442 measured the per-node cost rising 1.29 -> 8.43 us as the node count doubled).
///
/// Batching moves WHEN the buckets are swept, so the things that could break are membership
/// (does every bucket end up exact?), ORDER (the buckets are kept sorted ascending and
/// `has_label` binary-searches them), and ROLLBACK (the undo restores a deleted node, and it has
/// to land back in its buckets in order).
#[test]
fn batch_delete_keeps_every_label_bucket_exact_sorted_and_restorable() {
    use crate::value::Value;

    let build = || {
        let mut b = crate::store::Builder::default();
        // THREE overlapping labels, so a deleted node is in several buckets and a survivor is in
        // the same ones — a fixture where every node carried every label could not tell an exact
        // sweep from one that emptied the bucket.
        for i in 0..12u32 {
            let mut labels: Vec<&str> = vec!["Univ"];

            if i % 2 == 0 {
                labels.push("Even");
            }

            if i % 3 == 0 {
                labels.push("Third");
            }

            b.node(&labels, &[("k", Value::Num(f64::from(i)))]);
        }
        for i in 0..12u32 {
            b.edge(i, (i + 1) % 12, "E");
        }
        b.build()
    };
    let ids = |st: &crate::store::Store, l: &str| st.nodes_with_label(l).to_vec();

    // DELETE the `:Third` nodes (0, 3, 6, 9) and check all three buckets afterwards.
    let mut st = build();

    st.delete_nodes(&[0, 3, 6, 9]);

    assert_eq!(ids(&st, "Third"), Vec::<u32>::new(), "its own bucket");
    assert_eq!(ids(&st, "Even"), vec![2, 4, 8, 10], "an overlapping bucket");
    assert_eq!(
        ids(&st, "Univ"),
        vec![1, 2, 4, 5, 7, 8, 10, 11],
        "the bucket holding every node"
    );
    // SORTED ascending is load-bearing: `has_label` binary-searches the bucket.
    for l in ["Univ", "Even", "Third"] {
        let b = ids(&st, l);

        assert!(
            b.windows(2).all(|w| w[0] < w[1]),
            "{l} bucket lost its order"
        );
    }
    // And `has_label` agrees with the buckets, which is what the order is FOR.
    assert!(st.is_labeled(2, "Even"));
    assert!(
        !st.is_labeled(0, "Even"),
        "a deleted node still reads as labelled"
    );
    assert!(!st.is_labeled(9, "Univ"));

    // A NODE LISTED TWICE is deleted once and leaves the buckets exact — the `Applied` list can
    // name the same node from several matched rows.
    let mut st = build();

    st.delete_nodes(&[4, 4, 6, 4]);

    assert_eq!(ids(&st, "Even"), vec![0, 2, 8, 10]);
    assert_eq!(st.live_node_count(), 10);

    // ROLLBACK restores membership AND order. The undo captures the labels before the delete;
    // batching changed when the bucket removal happens, so this is the case that could regress.
    let mut st = build();

    st.begin();
    st.delete_nodes(&[0, 3, 6, 9]);

    assert_eq!(ids(&st, "Third"), Vec::<u32>::new());

    st.rollback();

    assert_eq!(
        ids(&st, "Third"),
        vec![0, 3, 6, 9],
        "rollback lost membership"
    );
    assert_eq!(ids(&st, "Even"), vec![0, 2, 4, 6, 8, 10]);
    assert_eq!(ids(&st, "Univ"), (0..12u32).collect::<Vec<_>>());

    for l in ["Univ", "Even", "Third"] {
        let b = ids(&st, l);

        assert!(
            b.windows(2).all(|w| w[0] < w[1]),
            "{l} bucket came back out of order"
        );
    }

    assert!(st.is_labeled(0, "Third"));
    assert_eq!(st.live_node_count(), 12);

    // The ONE-NODE path still works: `delete_node` is `delete_nodes(&[id])`, so there is one
    // implementation rather than two that can drift.
    let mut st = build();

    st.delete_node(5);

    assert_eq!(ids(&st, "Univ"), vec![0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
    assert_eq!(st.live_node_count(), 11);
}

/// Item 663: the TARGETED bucket path must clean a bucket that only a LATER victim is in.
///
/// `delete_nodes` now skips buckets none of its victims belong to, which is what makes a
/// single-node delete O(1) in the node count instead of O(total) — deleting one `Tmp` node used
/// to rewrite the whole `User` bucket too (0.130 us against 65.180 at 200,000 nodes).
///
/// ⚠️ MUTATION FOUND THIS CASE MISSING, and the reason is a fixture subtlety worth stating.
/// `batch_delete_keeps_every_label_bucket_exact_sorted_and_restorable` deletes `[0, 3, 6, 9]`,
/// and victim `0` happens to carry EVERY label in that fixture — so a mutant that checked only
/// `ids[0]` still touched every bucket and the test passed. The membership test is only
/// observable when a bucket holds a LATER victim and NOT the first one.
///
/// So the labels here are DISJOINT: `A` holds only node 0, `B` only node 1. Deleting both in one
/// call means bucket `B` is reachable solely through the second id.
#[test]
fn a_batch_delete_cleans_a_bucket_only_a_later_victim_is_in() {
    use crate::value::Value;

    let mut b = crate::store::Builder::default();
    let a0 = b.node(&["A"], &[("k", Value::Num(0.0))]);
    let b1 = b.node(&["B"], &[("k", Value::Num(1.0))]);
    // A survivor in each bucket, so an over-eager sweep that emptied the bucket would also fail
    // — the assertions below distinguish "exact" from "cleared".
    let a2 = b.node(&["A"], &[("k", Value::Num(2.0))]);
    let b3 = b.node(&["B"], &[("k", Value::Num(3.0))]);
    let mut st = b.build();

    // ONE call, two victims, in DISJOINT buckets. `A` is reachable through the first id and `B`
    // only through the second.
    st.delete_nodes(&[a0, b1]);

    assert_eq!(
        st.nodes_with_label("A"),
        vec![a2],
        "bucket A keeps only its survivor"
    );
    assert_eq!(
        st.nodes_with_label("B"),
        vec![b3],
        "bucket B is reachable ONLY through the second victim"
    );
    // Also checked from the NODE's side, not just the bucket's: a stale tombstone is observable
    // as a deleted node still reporting its label.
    assert!(
        !st.labels_of(b1).contains(&"B".to_string()),
        "the second victim must not still report its label"
    );
    assert!(
        !st.labels_of(a0).contains(&"A".to_string()),
        "nor the first"
    );
    assert_eq!(st.live_node_count(), 2);
}

/// Item 664: rolling back an insert must not disturb a bucket the inserted node is NOT in.
///
/// `pop_last_node` (the undo of `add_node`) used to drop the id with a full `retain` over every
/// label bucket, which made a rollback O(inserted x total nodes) — 200 inserts against 200,000
/// nodes cost 7.37 ms. It now pops only when the bucket's LAST element is that id, which is exact
/// because the popped node holds the highest id and the buckets are sorted ascending.
///
/// ⚠️ MUTATION FOUND THIS CASE MISSING, and it is the CORRUPTION one. Replacing the guarded pop
/// with an unconditional `b.pop()` SURVIVED the whole suite: every existing rollback test inserts
/// a node carrying the same label as the nodes already there, so every bucket contains the new id
/// and popping unconditionally happens to be right.
///
/// The failure needs a bucket that does NOT contain the inserted node. Here the graph holds `A`
/// nodes, the transaction inserts a `B`, and the rollback must leave `A` untouched — an
/// unconditional pop would evict `a2` from `A` instead, and `a2` would silently stop matching
/// `MATCH (n:A)`. That is data loss in an unrelated label, not a stale tombstone.
#[test]
fn rolling_back_an_insert_leaves_an_unrelated_label_bucket_intact() {
    use crate::value::Value;

    let mut b = crate::store::Builder::default();
    let a1 = b.node(&["A"], &[("k", Value::Num(1.0))]);
    // TWO `A` nodes, because an unconditional pop removes the bucket's LAST entry — with only one
    // member the bucket would empty either way and the assertion could not tell them apart.
    let a2 = b.node(&["A"], &[("k", Value::Num(2.0))]);
    let mut st = b.build();

    st.begin();

    let newcomer = st.add_node(&["B"], &[("k", Value::Num(3.0))]);

    assert_eq!(
        st.nodes_with_label("B"),
        vec![newcomer],
        "inserted while open"
    );

    st.rollback();

    // The inserted node is gone from its own bucket.
    assert_eq!(
        st.nodes_with_label("B"),
        Vec::<u32>::new(),
        "its own bucket"
    );
    // And the UNRELATED bucket is untouched — both members, in order.
    assert_eq!(
        st.nodes_with_label("A"),
        vec![a1, a2],
        "a bucket the inserted node was never in must not lose its last entry"
    );
    assert!(
        st.labels_of(a2).contains(&"A".to_string()),
        "the evicted-by-mistake node must still report its label"
    );
    assert_eq!(st.live_node_count(), 2);
}
