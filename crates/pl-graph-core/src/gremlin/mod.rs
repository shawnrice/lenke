//! A Gremlin traversal engine over the same columnar [`Graph`](crate::graph).
//!
//! Peer to the [`gql`](crate::gql) engine: a different query language binding to
//! the one core. Mirrors the TS `@pl-graph/gremlin` package's model — a plan is
//! a flat list of [`Step`]s (plain data, no closures), predicates are data, and
//! the [`exec`] module runs the step pipeline over a stream of traversers.
//!
//! The DSL is a fluent builder: `g().V().has("name", P::eq("marko")).out(&["KNOWS"])
//! .values(&["name"])`. Anonymous sub-traversals (for `where`/`and`/`repeat`/…)
//! start from [`__`].

use std::sync::Arc;

pub mod exec;
#[cfg(test)]
mod tests;

pub use exec::run;

/// A runtime traversal value. Graph elements are dense ids (like `gql::Val`);
/// `List`/`Map` carry `fold`/`valueMap`/`group`/`select` results.
#[derive(Clone, Debug, PartialEq)]
pub enum GVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    Vertex(u32),
    Edge(u32),
    List(Vec<GVal>),
    Map(Vec<(GVal, GVal)>),
}

impl From<f64> for GVal {
    fn from(n: f64) -> Self {
        GVal::Num(n)
    }
}
impl From<i32> for GVal {
    fn from(n: i32) -> Self {
        GVal::Num(n as f64)
    }
}
impl From<bool> for GVal {
    fn from(b: bool) -> Self {
        GVal::Bool(b)
    }
}
impl From<&str> for GVal {
    fn from(s: &str) -> Self {
        GVal::Str(Arc::from(s))
    }
}
impl From<String> for GVal {
    fn from(s: String) -> Self {
        GVal::Str(Arc::from(s.as_str()))
    }
}

/// A predicate (data, not a closure) used by `has`/`is`/`where`. Mirrors
/// Gremlin's `P`/`TextP`.
#[derive(Clone, Debug)]
pub enum P {
    Eq(GVal),
    Neq(GVal),
    Gt(GVal),
    Gte(GVal),
    Lt(GVal),
    Lte(GVal),
    /// Inclusive min, exclusive max (Gremlin `between`).
    Between(GVal, GVal),
    /// Exclusive both ends (Gremlin `inside`).
    Inside(GVal, GVal),
    /// `value < min || value > max` (Gremlin `outside`).
    Outside(GVal, GVal),
    Within(Vec<GVal>),
    Without(Vec<GVal>),
    StartsWith(String),
    EndingWith(String),
    Containing(String),
    NotContaining(String),
    Not(Box<P>),
}

impl P {
    pub fn eq(v: impl Into<GVal>) -> P {
        P::Eq(v.into())
    }
    pub fn neq(v: impl Into<GVal>) -> P {
        P::Neq(v.into())
    }
    pub fn gt(v: impl Into<GVal>) -> P {
        P::Gt(v.into())
    }
    pub fn gte(v: impl Into<GVal>) -> P {
        P::Gte(v.into())
    }
    pub fn lt(v: impl Into<GVal>) -> P {
        P::Lt(v.into())
    }
    pub fn lte(v: impl Into<GVal>) -> P {
        P::Lte(v.into())
    }
    pub fn between(min: impl Into<GVal>, max: impl Into<GVal>) -> P {
        P::Between(min.into(), max.into())
    }
    pub fn inside(min: impl Into<GVal>, max: impl Into<GVal>) -> P {
        P::Inside(min.into(), max.into())
    }
    pub fn outside(min: impl Into<GVal>, max: impl Into<GVal>) -> P {
        P::Outside(min.into(), max.into())
    }
    pub fn within<V: Into<GVal>>(vs: impl IntoIterator<Item = V>) -> P {
        P::Within(vs.into_iter().map(Into::into).collect())
    }
    pub fn without<V: Into<GVal>>(vs: impl IntoIterator<Item = V>) -> P {
        P::Without(vs.into_iter().map(Into::into).collect())
    }
    pub fn starts_with(s: &str) -> P {
        P::StartsWith(s.to_string())
    }
    pub fn containing(s: &str) -> P {
        P::Containing(s.to_string())
    }
    pub fn ending_with(s: &str) -> P {
        P::EndingWith(s.to_string())
    }
    pub fn not_containing(s: &str) -> P {
        P::NotContaining(s.to_string())
    }
    pub fn not(p: P) -> P {
        P::Not(Box::new(p))
    }
}

/// Sort direction for `order().by(...)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Order {
    Asc,
    Desc,
}

/// One traversal step (plain data — serializable, reorderable).
#[derive(Clone, Debug)]
pub enum Step {
    V(Vec<String>),
    E(Vec<String>),
    Out(Vec<String>),
    In(Vec<String>),
    Both(Vec<String>),
    OutE(Vec<String>),
    InE(Vec<String>),
    BothE(Vec<String>),
    OutV,
    InV,
    OtherV,
    BothV,
    Has(String, P),
    HasLabel(Vec<String>),
    HasId(Vec<String>),
    HasKey(Vec<String>),
    HasNot(Vec<String>),
    Is(P),
    Dedup,
    Values(Vec<String>),
    ValueMap(Vec<String>),
    Id,
    Label,
    Count,
    Fold,
    Sum,
    Min,
    Max,
    Mean,
    Order(Option<String>, Order),
    Limit(usize),
    Skip(usize),
    Range(usize, usize),
    Tail(usize),
    Where(Box<Traversal>),
    And(Vec<Traversal>),
    Or(Vec<Traversal>),
    Not(Box<Traversal>),
    Union(Vec<Traversal>),
    Coalesce(Vec<Traversal>),
    Optional(Box<Traversal>),
    Local(Box<Traversal>),
    Repeat { body: Box<Traversal>, times: Option<usize>, until: Option<Box<Traversal>>, emit: Option<Box<Traversal>>, emit_before: bool },
    As(String),
    Select(Vec<String>),
    Group(Option<String>, Option<String>),
    GroupCount(Option<String>),
    Path,
    SimplePath,
    CyclicPath,
    Unfold,
    Constant(GVal),
    Identity,
    Inject(Vec<GVal>),
    Dedupe,
}

fn strs(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|s| s.to_string()).collect()
}

/// A traversal plan: a fluent builder over a flat [`Step`] list.
#[derive(Clone, Debug, Default)]
pub struct Traversal {
    pub steps: Vec<Step>,
}

/// Start an anonymous (child) traversal for `where`/`and`/`repeat`/… sub-plans.
pub fn __() -> Traversal {
    Traversal::default()
}

/// Start a root traversal source `g`.
pub fn g() -> Traversal {
    Traversal::default()
}

impl Traversal {
    fn push(mut self, s: Step) -> Self {
        self.steps.push(s);
        self
    }

    // --- sources ---
    pub fn V(self) -> Self {
        self.push(Step::V(vec![]))
    }
    pub fn v_ids(self, ids: &[&str]) -> Self {
        self.push(Step::V(strs(ids)))
    }
    pub fn E(self) -> Self {
        self.push(Step::E(vec![]))
    }

    // --- movement ---
    pub fn out(self, labels: &[&str]) -> Self {
        self.push(Step::Out(strs(labels)))
    }
    pub fn in_(self, labels: &[&str]) -> Self {
        self.push(Step::In(strs(labels)))
    }
    pub fn both(self, labels: &[&str]) -> Self {
        self.push(Step::Both(strs(labels)))
    }
    pub fn out_e(self, labels: &[&str]) -> Self {
        self.push(Step::OutE(strs(labels)))
    }
    pub fn in_e(self, labels: &[&str]) -> Self {
        self.push(Step::InE(strs(labels)))
    }
    pub fn both_e(self, labels: &[&str]) -> Self {
        self.push(Step::BothE(strs(labels)))
    }
    pub fn out_v(self) -> Self {
        self.push(Step::OutV)
    }
    pub fn in_v(self) -> Self {
        self.push(Step::InV)
    }
    pub fn other_v(self) -> Self {
        self.push(Step::OtherV)
    }
    pub fn both_v(self) -> Self {
        self.push(Step::BothV)
    }

    // --- filters ---
    pub fn has(self, key: &str, pred: P) -> Self {
        self.push(Step::Has(key.to_string(), pred))
    }
    pub fn has_val(self, key: &str, v: impl Into<GVal>) -> Self {
        self.push(Step::Has(key.to_string(), P::Eq(v.into())))
    }
    pub fn has_label(self, labels: &[&str]) -> Self {
        self.push(Step::HasLabel(strs(labels)))
    }
    pub fn has_id(self, ids: &[&str]) -> Self {
        self.push(Step::HasId(strs(ids)))
    }
    pub fn has_key(self, keys: &[&str]) -> Self {
        self.push(Step::HasKey(strs(keys)))
    }
    pub fn has_not(self, keys: &[&str]) -> Self {
        self.push(Step::HasNot(strs(keys)))
    }
    pub fn is(self, pred: P) -> Self {
        self.push(Step::Is(pred))
    }
    pub fn dedup(self) -> Self {
        self.push(Step::Dedupe)
    }
    pub fn simple_path(self) -> Self {
        self.push(Step::SimplePath)
    }
    pub fn cyclic_path(self) -> Self {
        self.push(Step::CyclicPath)
    }

    // --- projection ---
    pub fn values(self, keys: &[&str]) -> Self {
        self.push(Step::Values(strs(keys)))
    }
    pub fn value_map(self, keys: &[&str]) -> Self {
        self.push(Step::ValueMap(strs(keys)))
    }
    pub fn id(self) -> Self {
        self.push(Step::Id)
    }
    pub fn label(self) -> Self {
        self.push(Step::Label)
    }
    pub fn path(self) -> Self {
        self.push(Step::Path)
    }

    // --- cardinality ---
    pub fn limit(self, n: usize) -> Self {
        self.push(Step::Limit(n))
    }
    pub fn skip(self, n: usize) -> Self {
        self.push(Step::Skip(n))
    }
    pub fn range(self, start: usize, end: usize) -> Self {
        self.push(Step::Range(start, end))
    }
    pub fn tail(self, n: usize) -> Self {
        self.push(Step::Tail(n))
    }

    // --- terminals / aggregates ---
    pub fn count(self) -> Self {
        self.push(Step::Count)
    }
    pub fn fold(self) -> Self {
        self.push(Step::Fold)
    }
    pub fn sum(self) -> Self {
        self.push(Step::Sum)
    }
    pub fn min(self) -> Self {
        self.push(Step::Min)
    }
    pub fn max(self) -> Self {
        self.push(Step::Max)
    }
    pub fn mean(self) -> Self {
        self.push(Step::Mean)
    }
    pub fn order(self) -> Self {
        self.push(Step::Order(None, Order::Asc))
    }
    pub fn order_by(self, key: &str, dir: Order) -> Self {
        self.push(Step::Order(Some(key.to_string()), dir))
    }
    pub fn group(self) -> Self {
        self.push(Step::Group(None, None))
    }
    pub fn group_by(self, key_by: &str, value_by: Option<&str>) -> Self {
        self.push(Step::Group(Some(key_by.to_string()), value_by.map(str::to_string)))
    }
    pub fn group_count(self, by: Option<&str>) -> Self {
        self.push(Step::GroupCount(by.map(str::to_string)))
    }

    // --- branch / combinators ---
    pub fn where_(self, sub: Traversal) -> Self {
        self.push(Step::Where(Box::new(sub)))
    }
    pub fn and(self, plans: Vec<Traversal>) -> Self {
        self.push(Step::And(plans))
    }
    pub fn or(self, plans: Vec<Traversal>) -> Self {
        self.push(Step::Or(plans))
    }
    pub fn not(self, sub: Traversal) -> Self {
        self.push(Step::Not(Box::new(sub)))
    }
    pub fn union(self, plans: Vec<Traversal>) -> Self {
        self.push(Step::Union(plans))
    }
    pub fn coalesce(self, plans: Vec<Traversal>) -> Self {
        self.push(Step::Coalesce(plans))
    }
    pub fn optional(self, sub: Traversal) -> Self {
        self.push(Step::Optional(Box::new(sub)))
    }
    pub fn local(self, sub: Traversal) -> Self {
        self.push(Step::Local(Box::new(sub)))
    }
    pub fn repeat(self, body: Traversal) -> Self {
        self.push(Step::Repeat { body: Box::new(body), times: None, until: None, emit: None, emit_before: false })
    }
    /// Bound the most recent `repeat` to `n` iterations (`repeat(b).times(n)`).
    pub fn times(mut self, n: usize) -> Self {
        if let Some(Step::Repeat { times, .. }) = self.steps.last_mut() {
            *times = Some(n);
        }
        self
    }
    /// Post-condition for the most recent `repeat` (`repeat(b).until(cond)`).
    pub fn until(mut self, cond: Traversal) -> Self {
        if let Some(Step::Repeat { until, .. }) = self.steps.last_mut() {
            *until = Some(Box::new(cond));
        }
        self
    }
    /// Emit modulator for the most recent `repeat` (post-form by default).
    pub fn emit(mut self, cond: Traversal) -> Self {
        if let Some(Step::Repeat { emit, .. }) = self.steps.last_mut() {
            *emit = Some(Box::new(cond));
        }
        self
    }

    // --- misc ---
    pub fn as_(self, label: &str) -> Self {
        self.push(Step::As(label.to_string()))
    }
    pub fn select(self, labels: &[&str]) -> Self {
        self.push(Step::Select(strs(labels)))
    }
    pub fn unfold(self) -> Self {
        self.push(Step::Unfold)
    }
    pub fn constant(self, v: impl Into<GVal>) -> Self {
        self.push(Step::Constant(v.into()))
    }
    pub fn identity(self) -> Self {
        self.push(Step::Identity)
    }
    pub fn inject<V: Into<GVal>>(self, vs: impl IntoIterator<Item = V>) -> Self {
        self.push(Step::Inject(vs.into_iter().map(Into::into).collect()))
    }

    /// Run against `graph`, returning the result values.
    pub fn run(&self, graph: &crate::graph::Graph) -> Vec<GVal> {
        run(graph, self)
    }
}
