//! A Gremlin traversal engine over the same columnar [`Graph`](crate::graph).
//!
//! Peer to the [`gql`](crate::gql) engine: a different query language binding to
//! the one core. Mirrors the TS `@pl-graph/gremlin` package's model — a plan is
//! a flat list of [`Step`]s (plain data, no closures), predicates are data, and
//! the [`exec`] module runs the step pipeline over a stream of traversers.
//!
//! The DSL is a fluent builder: `g().V().has("name", P::eq("marko")).out(&["KNOWS"])
//! .values(&["name"])`. Anonymous sub-traversals (for `where`/`and`/`repeat`/
//! `project().by(...)`/…) start from [`__`].
//!
//! Closure-bearing steps (`map(fn)`/`filter(fn)`/…) are intentionally omitted:
//! the data-plan model uses sub-traversals instead, which express the same logic.

use std::sync::Arc;

pub mod exec;
pub mod parse;
#[cfg(test)]
mod tests;

pub use exec::run;
pub use parse::parse;

/// A runtime traversal value. Graph elements are dense ids (like `gql::Val`);
/// `List`/`Map` carry `fold`/`valueMap`/`group`/`select`/`path` results.
#[derive(Clone, Debug, PartialEq)]
pub enum GVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    Vertex(u32),
    Edge(u32),
    List(Vec<GVal>),
    /// Insertion-ordered key→value pairs (valueMap / group / select / project).
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
    /// The single RHS value of a comparison predicate — for `where(start, pred)`,
    /// this names the end-tag label; `None` for range/set/text predicates.
    pub(crate) fn rhs(&self) -> Option<&GVal> {
        match self {
            P::Eq(v) | P::Neq(v) | P::Gt(v) | P::Gte(v) | P::Lt(v) | P::Lte(v) => Some(v),
            _ => None,
        }
    }
}

/// Sort direction for `order().by(...)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Order {
    Asc,
    Desc,
}

/// `select(pop, ...)` — which tagged value to recall when a label was set
/// multiple times (e.g. inside `repeat(out().as("a"))`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pop {
    First,
    Last,
    All,
}

/// Global (across the stream) vs local (over each traverser's iterable value).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scope {
    Global,
    Local,
}

/// A `T` token projected by a `by()` modulator (`by(T.id)` / `by(T.label)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Token {
    Id,
    Label,
    Key,
    Value,
}

/// A `by()` modulator: how to project a value before a parent step uses it.
#[derive(Clone, Debug)]
pub enum By {
    Identity(Option<Order>),
    Key(String, Option<Order>),
    Token(Token, Option<Order>),
    Traversal(Box<Traversal>, Option<Order>),
}

impl By {
    fn direction(&self) -> Option<Order> {
        match self {
            By::Identity(d) | By::Key(_, d) | By::Token(_, d) | By::Traversal(_, d) => *d,
        }
    }
}

/// An `addE` endpoint: the current traverser, a tagged vertex, or a sub-plan.
#[derive(Clone, Debug)]
pub enum Endpoint {
    Current,
    Tag(String),
    Plan(Box<Traversal>),
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
    HasValue(Vec<GVal>),
    Is(P),
    SimplePath,
    CyclicPath,
    Dedupe(Vec<By>),
    Values(Vec<String>),
    ValueMap(Vec<String>),
    PropertyMap(Vec<String>),
    ElementMap(Vec<String>),
    Properties(Vec<String>),
    Value,
    Id,
    Label,
    Path(Vec<By>),
    Project(Vec<String>, Vec<By>),
    Tree(Vec<By>),
    Limit(usize, Scope),
    Skip(usize, Scope),
    Range(usize, usize, Scope),
    Tail(usize, Scope),
    Sample(usize),
    Count(Scope),
    Fold,
    Sum(Scope),
    Min(Scope),
    Max(Scope),
    Mean(Scope),
    Order(Vec<By>, bool),
    Group(Vec<By>),
    GroupCount(Vec<By>),
    Where(Box<Traversal>),
    WhereKey(String, P, Vec<By>),
    And(Vec<Traversal>),
    Or(Vec<Traversal>),
    Not(Box<Traversal>),
    Union(Vec<Traversal>),
    Coalesce(Vec<Traversal>),
    Optional(Box<Traversal>),
    Local(Box<Traversal>),
    Choose { test: Box<Traversal>, then_: Box<Traversal>, else_: Option<Box<Traversal>> },
    Map(Box<Traversal>),
    FlatMap(Box<Traversal>),
    SideEffect(Box<Traversal>),
    Aggregate(String),
    Store(String),
    Cap(String),
    Barrier,
    Repeat { body: Box<Traversal>, times: Option<usize>, until: Option<Box<Traversal>>, emit: Option<Box<Traversal>>, emit_before: bool },
    As(String),
    Select { labels: Vec<String>, pop: Pop, bys: Vec<By> },
    Unfold,
    Index,
    Loops,
    Constant(GVal),
    Identity,
    Inject(Vec<GVal>),
    None(Option<P>),
    Fail(Option<String>),
    AddV(Option<String>),
    AddE { label: String, from: Endpoint, to: Endpoint },
    Property(String, GVal),
    Drop,
}

fn strs(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|s| s.to_string()).collect()
}

/// A traversal plan: a fluent builder over a flat [`Step`] list.
#[derive(Clone, Debug, Default)]
pub struct Traversal {
    pub steps: Vec<Step>,
}

/// Start an anonymous (child) traversal for `where`/`and`/`repeat`/`by`/… sub-plans.
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

    /// Attach a `by()` modulator to the most recent modulator-bearing step.
    fn attach_by(mut self, by: By) -> Self {
        if let Some(last) = self.steps.last_mut() {
            match last {
                Step::Order(bys, _)
                | Step::Group(bys)
                | Step::GroupCount(bys)
                | Step::Path(bys)
                | Step::Dedupe(bys)
                | Step::Tree(bys)
                | Step::Project(_, bys)
                | Step::WhereKey(_, _, bys)
                | Step::Select { bys, .. } => bys.push(by),
                _ => {}
            }
        }
        self
    }

    // --- by() modulators ---
    pub fn by(self, key: &str) -> Self {
        self.attach_by(By::Key(key.to_string(), None))
    }
    pub fn by_identity(self) -> Self {
        self.attach_by(By::Identity(None))
    }
    pub fn by_token(self, tok: Token) -> Self {
        self.attach_by(By::Token(tok, None))
    }
    pub fn by_id(self) -> Self {
        self.attach_by(By::Token(Token::Id, None))
    }
    pub fn by_label(self) -> Self {
        self.attach_by(By::Token(Token::Label, None))
    }
    pub fn by_t(self, t: Traversal) -> Self {
        self.attach_by(By::Traversal(Box::new(t), None))
    }
    pub fn by_dir(self, key: &str, dir: Order) -> Self {
        self.attach_by(By::Key(key.to_string(), Some(dir)))
    }
    pub fn by_identity_dir(self, dir: Order) -> Self {
        self.attach_by(By::Identity(Some(dir)))
    }
    pub fn by_t_dir(self, t: Traversal, dir: Order) -> Self {
        self.attach_by(By::Traversal(Box::new(t), Some(dir)))
    }

    // --- sources ---
    #[allow(non_snake_case)]
    pub fn V(self) -> Self {
        self.push(Step::V(vec![]))
    }
    pub fn v_ids(self, ids: &[&str]) -> Self {
        self.push(Step::V(strs(ids)))
    }
    #[allow(non_snake_case)]
    pub fn E(self) -> Self {
        self.push(Step::E(vec![]))
    }
    pub fn e_ids(self, ids: &[&str]) -> Self {
        self.push(Step::E(strs(ids)))
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
    /// `has(label, key, pred)` — `hasLabel(label).has(key, pred)`.
    pub fn has_label_key(self, label: &str, key: &str, pred: P) -> Self {
        self.push(Step::HasLabel(vec![label.to_string()])).push(Step::Has(key.to_string(), pred))
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
    pub fn has_value<V: Into<GVal>>(self, vs: impl IntoIterator<Item = V>) -> Self {
        self.push(Step::HasValue(vs.into_iter().map(Into::into).collect()))
    }
    pub fn is(self, pred: P) -> Self {
        self.push(Step::Is(pred))
    }
    pub fn dedup(self) -> Self {
        self.push(Step::Dedupe(vec![]))
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
    pub fn property_map(self, keys: &[&str]) -> Self {
        self.push(Step::PropertyMap(strs(keys)))
    }
    pub fn element_map(self, keys: &[&str]) -> Self {
        self.push(Step::ElementMap(strs(keys)))
    }
    pub fn properties(self, keys: &[&str]) -> Self {
        self.push(Step::Properties(strs(keys)))
    }
    pub fn value(self) -> Self {
        self.push(Step::Value)
    }
    pub fn id(self) -> Self {
        self.push(Step::Id)
    }
    pub fn label(self) -> Self {
        self.push(Step::Label)
    }
    pub fn path(self) -> Self {
        self.push(Step::Path(vec![]))
    }
    pub fn project(self, keys: &[&str]) -> Self {
        self.push(Step::Project(strs(keys), vec![]))
    }
    pub fn tree(self) -> Self {
        self.push(Step::Tree(vec![]))
    }

    // --- cardinality ---
    pub fn limit(self, n: usize) -> Self {
        self.push(Step::Limit(n, Scope::Global))
    }
    pub fn limit_local(self, n: usize) -> Self {
        self.push(Step::Limit(n, Scope::Local))
    }
    pub fn skip(self, n: usize) -> Self {
        self.push(Step::Skip(n, Scope::Global))
    }
    pub fn range(self, start: usize, end: usize) -> Self {
        self.push(Step::Range(start, end, Scope::Global))
    }
    pub fn range_local(self, start: usize, end: usize) -> Self {
        self.push(Step::Range(start, end, Scope::Local))
    }
    pub fn tail(self, n: usize) -> Self {
        self.push(Step::Tail(n, Scope::Global))
    }
    pub fn sample(self, n: usize) -> Self {
        self.push(Step::Sample(n))
    }

    // --- terminals / aggregates ---
    pub fn count(self) -> Self {
        self.push(Step::Count(Scope::Global))
    }
    pub fn count_local(self) -> Self {
        self.push(Step::Count(Scope::Local))
    }
    pub fn fold(self) -> Self {
        self.push(Step::Fold)
    }
    pub fn sum(self) -> Self {
        self.push(Step::Sum(Scope::Global))
    }
    pub fn sum_local(self) -> Self {
        self.push(Step::Sum(Scope::Local))
    }
    pub fn min(self) -> Self {
        self.push(Step::Min(Scope::Global))
    }
    pub fn max(self) -> Self {
        self.push(Step::Max(Scope::Global))
    }
    pub fn mean(self) -> Self {
        self.push(Step::Mean(Scope::Global))
    }
    pub fn order(self) -> Self {
        self.push(Step::Order(vec![], false))
    }
    pub fn order_by(self, key: &str, dir: Order) -> Self {
        self.push(Step::Order(vec![By::Key(key.to_string(), Some(dir))], false))
    }
    pub fn group(self) -> Self {
        self.push(Step::Group(vec![]))
    }
    pub fn group_count(self) -> Self {
        self.push(Step::GroupCount(vec![]))
    }

    // --- branch / combinators ---
    pub fn where_(self, sub: Traversal) -> Self {
        self.push(Step::Where(Box::new(sub)))
    }
    pub fn where_key(self, start: &str, pred: P) -> Self {
        self.push(Step::WhereKey(start.to_string(), pred, vec![]))
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
    pub fn choose(self, test: Traversal, then_: Traversal) -> Self {
        self.push(Step::Choose { test: Box::new(test), then_: Box::new(then_), else_: None })
    }
    pub fn choose_else(self, test: Traversal, then_: Traversal, else_: Traversal) -> Self {
        self.push(Step::Choose { test: Box::new(test), then_: Box::new(then_), else_: Some(Box::new(else_)) })
    }
    pub fn map(self, sub: Traversal) -> Self {
        self.push(Step::Map(Box::new(sub)))
    }
    pub fn flat_map(self, sub: Traversal) -> Self {
        self.push(Step::FlatMap(Box::new(sub)))
    }
    pub fn filter(self, sub: Traversal) -> Self {
        self.push(Step::Where(Box::new(sub)))
    }
    pub fn side_effect(self, sub: Traversal) -> Self {
        self.push(Step::SideEffect(Box::new(sub)))
    }
    pub fn aggregate(self, key: &str) -> Self {
        self.push(Step::Aggregate(key.to_string()))
    }
    pub fn store(self, key: &str) -> Self {
        self.push(Step::Store(key.to_string()))
    }
    pub fn cap(self, key: &str) -> Self {
        self.push(Step::Cap(key.to_string()))
    }
    pub fn barrier(self) -> Self {
        self.push(Step::Barrier)
    }
    pub fn repeat(self, body: Traversal) -> Self {
        self.push(Step::Repeat { body: Box::new(body), times: None, until: None, emit: None, emit_before: false })
    }
    pub fn times(mut self, n: usize) -> Self {
        if let Some(Step::Repeat { times, .. }) = self.steps.last_mut() {
            *times = Some(n);
        }
        self
    }
    pub fn until(mut self, cond: Traversal) -> Self {
        if let Some(Step::Repeat { until, .. }) = self.steps.last_mut() {
            *until = Some(Box::new(cond));
        }
        self
    }
    pub fn emit(mut self, cond: Traversal) -> Self {
        if let Some(Step::Repeat { emit, .. }) = self.steps.last_mut() {
            *emit = Some(Box::new(cond));
        }
        self
    }
    /// Empty-condition emit (`emit()` with no filter — emit every body output).
    pub fn emit_all(mut self) -> Self {
        if let Some(Step::Repeat { emit, .. }) = self.steps.last_mut() {
            *emit = Some(Box::new(Traversal::default()));
        }
        self
    }
    pub fn emit_before(mut self, cond: Traversal) -> Self {
        if let Some(Step::Repeat { emit, emit_before, .. }) = self.steps.last_mut() {
            *emit = Some(Box::new(cond));
            *emit_before = true;
        }
        self
    }

    // --- tagging / select ---
    pub fn as_(self, label: &str) -> Self {
        self.push(Step::As(label.to_string()))
    }
    pub fn select(self, labels: &[&str]) -> Self {
        self.push(Step::Select { labels: strs(labels), pop: Pop::Last, bys: vec![] })
    }
    pub fn select_pop(self, pop: Pop, labels: &[&str]) -> Self {
        self.push(Step::Select { labels: strs(labels), pop, bys: vec![] })
    }

    // --- misc ---
    pub fn unfold(self) -> Self {
        self.push(Step::Unfold)
    }
    pub fn index(self) -> Self {
        self.push(Step::Index)
    }
    pub fn loops(self) -> Self {
        self.push(Step::Loops)
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
    pub fn none(self) -> Self {
        self.push(Step::None(None))
    }
    pub fn none_pred(self, pred: P) -> Self {
        self.push(Step::None(Some(pred)))
    }
    pub fn fail(self, msg: &str) -> Self {
        self.push(Step::Fail(Some(msg.to_string())))
    }

    // --- mutation ---
    pub fn add_v(self, label: Option<&str>) -> Self {
        self.push(Step::AddV(label.map(str::to_string)))
    }
    pub fn add_e(self, label: &str) -> Self {
        self.push(Step::AddE { label: label.to_string(), from: Endpoint::Current, to: Endpoint::Current })
    }
    pub fn from_tag(mut self, label: &str) -> Self {
        if let Some(Step::AddE { from, .. }) = self.steps.last_mut() {
            *from = Endpoint::Tag(label.to_string());
        }
        self
    }
    pub fn to_tag(mut self, label: &str) -> Self {
        if let Some(Step::AddE { to, .. }) = self.steps.last_mut() {
            *to = Endpoint::Tag(label.to_string());
        }
        self
    }
    pub fn from_plan(mut self, plan: Traversal) -> Self {
        if let Some(Step::AddE { from, .. }) = self.steps.last_mut() {
            *from = Endpoint::Plan(Box::new(plan));
        }
        self
    }
    pub fn to_plan(mut self, plan: Traversal) -> Self {
        if let Some(Step::AddE { to, .. }) = self.steps.last_mut() {
            *to = Endpoint::Plan(Box::new(plan));
        }
        self
    }
    pub fn property(self, key: &str, v: impl Into<GVal>) -> Self {
        self.push(Step::Property(key.to_string(), v.into()))
    }
    pub fn drop(self) -> Self {
        self.push(Step::Drop)
    }

    /// Run against `graph` (mutable, since `addV`/`addE`/`property`/`drop` mutate;
    /// read-only traversals just don't touch it — same convention as `gql::execute`).
    pub fn run(&self, graph: &mut crate::graph::Graph) -> Vec<GVal> {
        run(graph, self)
    }
}
