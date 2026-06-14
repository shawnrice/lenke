//! The lowered intermediate representation (IR) and the `lower` pass.
//!
//! A parsed [`Query`](super::ast::Query) is *lowered* once into a `CQuery` that
//! bakes every graph- and param-independent decision: `$param` → a positional
//! slot, **variable → a binding slot**, function name → an enum, aggregate
//! detection, projection column names and group keys. This is the artifact a
//! [`prepared`](super::prepare) statement holds, paid once and reused.
//!
//! Variable slots: a `Scope` maps each in-scope variable name to an index into a
//! `Vec<Option<Val>>` binding, so the per-row hot path indexes an array instead
//! of scanning a name list. `WITH` starts a fresh scope (its output columns);
//! correlated sub-queries extend the scope with their own pattern variables.
//!
//! Graph-dependent resolution (property key → id) stays at execute time — the
//! graph is mutable and key ids are graph-specific.

use super::ast::*;

/// A variable reference that resolves to no in-scope slot reads as NULL.
pub const UNBOUND: usize = usize::MAX;

/// Scalar (non-aggregate) functions, resolved from a name once. `Unknown` keeps
/// the engine total (an unknown function evaluates to NULL, as before).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScalarFn {
    Abs,
    Ceil,
    Floor,
    Sqrt,
    Exp,
    Ln,
    Log10,
    Sin,
    Cos,
    Tan,
    Cot,
    Asin,
    Acos,
    Atan,
    Sinh,
    Cosh,
    Tanh,
    Degrees,
    Radians,
    Upper,
    Lower,
    Trim,
    Ltrim,
    Rtrim,
    CharLength,
    Power,
    Mod,
    Log,
    Size,
    Left,
    Right,
    Coalesce,
    Nullif,
    ElementId,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AggFn {
    Count,
    Sum,
    Avg,
    Min,
    Max,
    CollectList,
}

fn agg_fn(name: &str) -> Option<AggFn> {
    Some(match name {
        "count" => AggFn::Count,
        "sum" => AggFn::Sum,
        "avg" => AggFn::Avg,
        "min" => AggFn::Min,
        "max" => AggFn::Max,
        "collect_list" => AggFn::CollectList,
        _ => return None,
    })
}

fn scalar_fn(name: &str) -> ScalarFn {
    match name {
        "abs" => ScalarFn::Abs,
        "ceil" | "ceiling" => ScalarFn::Ceil,
        "floor" => ScalarFn::Floor,
        "sqrt" => ScalarFn::Sqrt,
        "exp" => ScalarFn::Exp,
        "ln" => ScalarFn::Ln,
        "log10" => ScalarFn::Log10,
        "sin" => ScalarFn::Sin,
        "cos" => ScalarFn::Cos,
        "tan" => ScalarFn::Tan,
        "cot" => ScalarFn::Cot,
        "asin" => ScalarFn::Asin,
        "acos" => ScalarFn::Acos,
        "atan" => ScalarFn::Atan,
        "sinh" => ScalarFn::Sinh,
        "cosh" => ScalarFn::Cosh,
        "tanh" => ScalarFn::Tanh,
        "degrees" => ScalarFn::Degrees,
        "radians" => ScalarFn::Radians,
        "upper" => ScalarFn::Upper,
        "lower" => ScalarFn::Lower,
        "trim" | "btrim" => ScalarFn::Trim,
        "ltrim" => ScalarFn::Ltrim,
        "rtrim" => ScalarFn::Rtrim,
        "char_length" | "character_length" => ScalarFn::CharLength,
        "power" => ScalarFn::Power,
        "mod" => ScalarFn::Mod,
        "log" => ScalarFn::Log,
        "size" | "length" => ScalarFn::Size,
        "left" => ScalarFn::Left,
        "right" => ScalarFn::Right,
        "coalesce" => ScalarFn::Coalesce,
        "nullif" => ScalarFn::Nullif,
        "element_id" => ScalarFn::ElementId,
        _ => ScalarFn::Unknown,
    }
}

/// A lowered label expression: each label name is a `ref` index resolved once
/// per execution to a (vertex-label id, edge-type id) pair (a name can be both).
#[derive(Debug, Clone)]
pub enum CLabelExpr {
    Label(usize),
    Wildcard,
    Not(Box<CLabelExpr>),
    And(Box<CLabelExpr>, Box<CLabelExpr>),
    Or(Box<CLabelExpr>, Box<CLabelExpr>),
}

/// Lowered expression. Variables and properties carry a binding slot; `$param` a
/// positional slot; property keys and label names a ref resolved per execution;
/// functions a resolved enum tag.
#[derive(Debug, Clone)]
pub enum CExpr {
    Var(usize),
    Param(usize),
    Prop { var_slot: usize, key_ref: usize },
    Lit(Lit),
    List(Vec<CExpr>),
    Compare { op: CompareOp, left: Box<CExpr>, right: Box<CExpr> },
    Arith { op: ArithOp, left: Box<CExpr>, right: Box<CExpr> },
    Concat { left: Box<CExpr>, right: Box<CExpr> },
    Neg(Box<CExpr>),
    And(Box<CExpr>, Box<CExpr>),
    Or(Box<CExpr>, Box<CExpr>),
    Xor(Box<CExpr>, Box<CExpr>),
    Not(Box<CExpr>),
    IsNull { expr: Box<CExpr>, negated: bool },
    IsTruth { expr: Box<CExpr>, truth: Option<bool>, negated: bool },
    IsLabeled { expr: Box<CExpr>, label: CLabelExpr, negated: bool },
    In { expr: Box<CExpr>, list: Box<CExpr>, negated: bool },
    /// Correlated sub-pattern existence; `sub_len` is the sub-scope slot count.
    Exists { patterns: Vec<CPath>, where_: Option<Box<CExpr>>, sub_len: usize },
    CountSubquery { patterns: Vec<CPath>, where_: Option<Box<CExpr>>, sub_len: usize },
    Case { subject: Option<Box<CExpr>>, whens: Vec<(CExpr, CExpr)>, else_: Option<Box<CExpr>> },
    Scalar { func: ScalarFn, args: Vec<CExpr> },
    Aggregate { func: AggFn, arg: Option<Box<CExpr>>, distinct: bool, star: bool },
    /// Reference to a projection's `i`th extracted aggregate (its folded value).
    /// Projection/ORDER BY expressions have their aggregates lifted out into
    /// `CProjection::aggs` and replaced by these, so a group folds incrementally.
    AggRef(usize),
}

/// A bytecode instruction for the expression VM (a stack machine). Compiled from
/// `CExpr` once at lower time; executed by a flat loop over a `Vec<Op>` against a
/// small operand stack — contiguous instructions instead of a pointer-chased
/// boxed tree. `Tree` is the escape hatch: control-flow / subquery / aggregate
/// nodes fall back to the tree-walking interpreter for that subexpression.
#[derive(Debug, Clone)]
pub enum Op {
    Const(Lit),
    Var(usize),
    Param(usize),
    Prop { var_slot: usize, key_ref: usize },
    MakeList(usize),
    Arith(ArithOp),
    Compare(CompareOp),
    Concat,
    Neg,
    Not,
    And,
    Or,
    Xor,
    IsNull(bool),
    IsTruth(Option<bool>, bool),
    IsLabeled(CLabelExpr, bool),
    In(bool),
    Scalar(ScalarFn, usize),
    AggRef(usize),
    /// Fall back to the tree-walk for this subexpression (CASE / EXISTS / COUNT{}
    /// / aggregate) and push its value.
    Tree(CExpr),
}

/// A compiled expression: a flat instruction stream for the VM.
#[derive(Debug, Clone)]
pub struct Program(pub Vec<Op>);

fn emit(e: &CExpr, out: &mut Vec<Op>) {
    match e {
        CExpr::Lit(l) => out.push(Op::Const(l.clone())),
        CExpr::Var(s) => out.push(Op::Var(*s)),
        CExpr::Param(s) => out.push(Op::Param(*s)),
        CExpr::Prop { var_slot, key_ref } => out.push(Op::Prop { var_slot: *var_slot, key_ref: *key_ref }),
        CExpr::List(items) => {
            for it in items {
                emit(it, out);
            }
            out.push(Op::MakeList(items.len()));
        }
        CExpr::Arith { op, left, right } => {
            emit(left, out);
            emit(right, out);
            out.push(Op::Arith(*op));
        }
        CExpr::Compare { op, left, right } => {
            emit(left, out);
            emit(right, out);
            out.push(Op::Compare(*op));
        }
        CExpr::Concat { left, right } => {
            emit(left, out);
            emit(right, out);
            out.push(Op::Concat);
        }
        CExpr::Neg(x) => {
            emit(x, out);
            out.push(Op::Neg);
        }
        CExpr::And(l, r) => {
            emit(l, out);
            emit(r, out);
            out.push(Op::And);
        }
        CExpr::Or(l, r) => {
            emit(l, out);
            emit(r, out);
            out.push(Op::Or);
        }
        CExpr::Xor(l, r) => {
            emit(l, out);
            emit(r, out);
            out.push(Op::Xor);
        }
        CExpr::Not(x) => {
            emit(x, out);
            out.push(Op::Not);
        }
        CExpr::IsNull { expr, negated } => {
            emit(expr, out);
            out.push(Op::IsNull(*negated));
        }
        CExpr::IsTruth { expr, truth, negated } => {
            emit(expr, out);
            out.push(Op::IsTruth(*truth, *negated));
        }
        CExpr::IsLabeled { expr, label, negated } => {
            emit(expr, out);
            out.push(Op::IsLabeled(label.clone(), *negated));
        }
        CExpr::In { expr, list, negated } => {
            emit(expr, out);
            emit(list, out);
            out.push(Op::In(*negated));
        }
        CExpr::Scalar { func, args } => {
            for a in args {
                emit(a, out);
            }
            out.push(Op::Scalar(*func, args.len()));
        }
        CExpr::AggRef(i) => out.push(Op::AggRef(*i)),
        // Control flow / subquery / aggregate: tree-walk this subexpression.
        CExpr::Case { .. } | CExpr::Exists { .. } | CExpr::CountSubquery { .. } | CExpr::Aggregate { .. } => {
            out.push(Op::Tree(e.clone()))
        }
    }
}

/// Compile a lowered expression to a VM `Program`.
pub fn compile_program(e: &CExpr) -> Program {
    let mut out = Vec::new();
    emit(e, &mut out);
    Program(out)
}

/// An aggregate lifted out of a projection expression (folded once per group).
#[derive(Debug, Clone)]
pub struct CAgg {
    pub func: AggFn,
    pub arg: Option<CExpr>,
    pub distinct: bool,
    pub star: bool,
}

#[derive(Debug, Clone)]
pub struct CPropConstraint {
    /// Key name (for INSERT, which creates the property) …
    pub key: String,
    /// … and its resolved ref (for MATCH, which reads the property).
    pub key_ref: usize,
    pub value: CExpr,
}

#[derive(Debug, Clone)]
pub struct CNode {
    /// Binding slot this node's variable occupies (`None` if anonymous).
    pub var_slot: Option<usize>,
    pub label: Option<CLabelExpr>,
    pub props: Vec<CPropConstraint>,
    pub where_: Option<CExpr>,
}

#[derive(Debug, Clone)]
pub struct CRel {
    pub var_slot: Option<usize>,
    pub label: Option<CLabelExpr>,
    pub direction: Direction,
    pub props: Vec<CPropConstraint>,
    pub where_: Option<CExpr>,
    pub quantifier: Option<Quantifier>,
}

#[derive(Debug, Clone)]
pub struct CSegment {
    pub rel: CRel,
    pub node: CNode,
}

#[derive(Debug, Clone)]
pub struct CPath {
    pub start: CNode,
    pub segments: Vec<CSegment>,
}

#[derive(Debug, Clone)]
pub struct CReturnItem {
    pub expr: CExpr,
    /// Compiled form of `expr` for the stack-machine VM (hot per-row site).
    pub prog: Program,
    pub name: String,
    pub is_agg: bool,
}

#[derive(Debug, Clone)]
pub struct CSortItem {
    pub expr: CExpr,
    pub descending: bool,
    pub nulls_first: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct CProjection {
    pub star: bool,
    pub distinct: bool,
    pub items: Vec<CReturnItem>,
    /// True when any item aggregates → implicit grouping (precomputed).
    pub aggregating: bool,
    /// Aggregates lifted out of the item/ORDER BY expressions, folded per group;
    /// the expressions reference them via [`CExpr::AggRef`].
    pub aggs: Vec<CAgg>,
    /// Output slot count (= column count). Output slot `i` holds column `i`.
    pub out_len: usize,
    /// Output column names, indexed by output slot.
    pub out_names: Vec<String>,
    /// For `*`: the input slots to carry across (aligned with `out_names`).
    pub star_cols: Vec<usize>,
    pub order_by: Vec<CSortItem>,
    /// Input slots appended after the output slots to form the ORDER BY scope —
    /// lets a sort key reference an input variable not in the output.
    pub order_overlay: Vec<usize>,
    /// True if any ORDER BY key references an output column (slot < `out_len`).
    /// When false, sort keys come from the input alone, so `ORDER BY … LIMIT n`
    /// can keep only the top-k *input* bindings and project just those.
    pub order_needs_output: bool,
    pub skip: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum CSetItem {
    Prop { var_slot: usize, key: String, value: CExpr },
    Label { var_slot: usize, label: String },
}

#[derive(Debug, Clone)]
pub enum CRemoveItem {
    Prop { var_slot: usize, key: String },
    Label { var_slot: usize, label: String },
}

#[derive(Debug, Clone)]
pub enum CClause {
    /// `scope_len` is the binding slot count after this match (incl. its vars).
    Match {
        optional: bool,
        patterns: Vec<CPath>,
        where_: Option<CExpr>,
        /// Compiled form of `where_` for the VM (hot per-row site).
        where_prog: Option<Program>,
        scope_len: usize,
    },
    With { projection: CProjection, where_: Option<CExpr>, where_prog: Option<Program> },
    Return(CProjection),
    Insert(Vec<CPath>),
    Set(Vec<CSetItem>),
    Remove(Vec<CRemoveItem>),
    Delete { detach: bool, targets: Vec<CExpr> },
    Finish,
}

#[derive(Debug, Clone)]
pub struct CLinear {
    pub clauses: Vec<CClause>,
}

#[derive(Debug, Clone)]
pub struct CQuery {
    pub parts: Vec<CLinear>,
    pub ops: Vec<SetOp>,
    /// Property-key names, indexed by `key_ref`; resolved to ids per execution.
    pub key_names: Vec<String>,
    /// Label/edge-type names, indexed by label ref; resolved to ids per execution.
    pub label_names: Vec<String>,
}

/// Does a lowered expression contain an aggregate anywhere?
fn has_aggregate(expr: &CExpr) -> bool {
    match expr {
        CExpr::Aggregate { .. } => true,
        CExpr::Scalar { args, .. } => args.iter().any(has_aggregate),
        CExpr::Neg(e) | CExpr::Not(e) => has_aggregate(e),
        CExpr::IsNull { expr, .. } | CExpr::IsTruth { expr, .. } | CExpr::IsLabeled { expr, .. } => {
            has_aggregate(expr)
        }
        CExpr::Arith { left, right, .. }
        | CExpr::Concat { left, right }
        | CExpr::And(left, right)
        | CExpr::Or(left, right)
        | CExpr::Xor(left, right)
        | CExpr::Compare { left, right, .. } => has_aggregate(left) || has_aggregate(right),
        CExpr::In { expr, list, .. } => has_aggregate(expr) || has_aggregate(list),
        CExpr::List(items) => items.iter().any(has_aggregate),
        CExpr::Case { subject, whens, else_ } => {
            subject.as_deref().is_some_and(has_aggregate)
                || whens.iter().any(|(w, t)| has_aggregate(w) || has_aggregate(t))
                || else_.as_deref().is_some_and(has_aggregate)
        }
        _ => false,
    }
}

/// Lift aggregate sub-expressions out of `expr` into `aggs`, replacing each with
/// an [`CExpr::AggRef`]. An aggregate's own argument is left intact (a nested
/// aggregate is invalid), so this never recurses into an `Aggregate`.
fn extract_aggs(expr: CExpr, aggs: &mut Vec<CAgg>) -> CExpr {
    let b = |e: Box<CExpr>, aggs: &mut Vec<CAgg>| Box::new(extract_aggs(*e, aggs));
    match expr {
        CExpr::Aggregate { func, arg, distinct, star } => {
            let idx = aggs.len();
            aggs.push(CAgg { func, arg: arg.map(|a| *a), distinct, star });
            CExpr::AggRef(idx)
        }
        CExpr::List(items) => CExpr::List(items.into_iter().map(|e| extract_aggs(e, aggs)).collect()),
        CExpr::Compare { op, left, right } => CExpr::Compare { op, left: b(left, aggs), right: b(right, aggs) },
        CExpr::Arith { op, left, right } => CExpr::Arith { op, left: b(left, aggs), right: b(right, aggs) },
        CExpr::Concat { left, right } => CExpr::Concat { left: b(left, aggs), right: b(right, aggs) },
        CExpr::Neg(e) => CExpr::Neg(b(e, aggs)),
        CExpr::And(l, r) => CExpr::And(b(l, aggs), b(r, aggs)),
        CExpr::Or(l, r) => CExpr::Or(b(l, aggs), b(r, aggs)),
        CExpr::Xor(l, r) => CExpr::Xor(b(l, aggs), b(r, aggs)),
        CExpr::Not(e) => CExpr::Not(b(e, aggs)),
        CExpr::IsNull { expr, negated } => CExpr::IsNull { expr: b(expr, aggs), negated },
        CExpr::IsTruth { expr, truth, negated } => CExpr::IsTruth { expr: b(expr, aggs), truth, negated },
        CExpr::IsLabeled { expr, label, negated } => CExpr::IsLabeled { expr: b(expr, aggs), label, negated },
        CExpr::In { expr, list, negated } => CExpr::In { expr: b(expr, aggs), list: b(list, aggs), negated },
        CExpr::Case { subject, whens, else_ } => CExpr::Case {
            subject: subject.map(|s| b(s, aggs)),
            whens: whens.into_iter().map(|(w, t)| (extract_aggs(w, aggs), extract_aggs(t, aggs))).collect(),
            else_: else_.map(|e| b(e, aggs)),
        },
        CExpr::Scalar { func, args } => {
            CExpr::Scalar { func, args: args.into_iter().map(|e| extract_aggs(e, aggs)).collect() }
        }
        // leaves and the (correlated) sub-queries carry no grouping aggregate
        other => other,
    }
}

/// Does a lowered expression reference any variable/property slot below `n`?
/// Used to tell whether an ORDER BY key reads an output column (slot < out_len).
fn refs_slot_below(expr: &CExpr, n: usize) -> bool {
    match expr {
        CExpr::Var(s) => *s < n,
        CExpr::Prop { var_slot, .. } => *var_slot < n,
        CExpr::List(items) => items.iter().any(|e| refs_slot_below(e, n)),
        CExpr::Neg(e) | CExpr::Not(e) => refs_slot_below(e, n),
        CExpr::IsNull { expr, .. } | CExpr::IsTruth { expr, .. } | CExpr::IsLabeled { expr, .. } => {
            refs_slot_below(expr, n)
        }
        CExpr::Arith { left, right, .. }
        | CExpr::Concat { left, right }
        | CExpr::And(left, right)
        | CExpr::Or(left, right)
        | CExpr::Xor(left, right)
        | CExpr::Compare { left, right, .. } => refs_slot_below(left, n) || refs_slot_below(right, n),
        CExpr::In { expr, list, .. } => refs_slot_below(expr, n) || refs_slot_below(list, n),
        CExpr::Case { subject, whens, else_ } => {
            subject.as_deref().is_some_and(|e| refs_slot_below(e, n))
                || whens.iter().any(|(w, t)| refs_slot_below(w, n) || refs_slot_below(t, n))
                || else_.as_deref().is_some_and(|e| refs_slot_below(e, n))
        }
        CExpr::Scalar { args, .. } => args.iter().any(|e| refs_slot_below(e, n)),
        CExpr::Aggregate { arg, .. } => arg.as_deref().is_some_and(|e| refs_slot_below(e, n)),
        // exists/count subqueries correlate via their own bindings; lits/params/aggref don't.
        _ => false,
    }
}

/// The default output column name (from the source AST, which still has names).
fn column_name(expr: &Expr) -> String {
    match expr {
        Expr::Var(name) => name.clone(),
        Expr::Prop { variable, key } => format!("{variable}.{key}"),
        _ => "expr".to_string(),
    }
}

/// Lowers a `Query`, allocating `$param` slots and per-scope variable slots.
struct Lowerer {
    /// param slot -> name (the order positional args are bound in at execute).
    params: Vec<String>,
    /// current scope: variable slot -> name.
    scope: Vec<String>,
    /// property-key ref -> name (resolved to ids per execution).
    keys: Vec<String>,
    /// label/edge-type ref -> name (resolved to ids per execution).
    labels: Vec<String>,
}

/// Intern `name` into `table`, returning its ref index.
fn intern_ref(table: &mut Vec<String>, name: &str) -> usize {
    if let Some(i) = table.iter().position(|n| n == name) {
        i
    } else {
        table.push(name.to_string());
        table.len() - 1
    }
}

impl Lowerer {
    fn param_slot(&mut self, name: &str) -> usize {
        if let Some(i) = self.params.iter().position(|n| n == name) {
            i
        } else {
            self.params.push(name.to_string());
            self.params.len() - 1
        }
    }

    /// Lower a label expression, assigning a ref to each label name.
    fn label_expr(&mut self, e: &LabelExpr) -> CLabelExpr {
        match e {
            LabelExpr::Label(name) => CLabelExpr::Label(intern_ref(&mut self.labels, name)),
            LabelExpr::Wildcard => CLabelExpr::Wildcard,
            LabelExpr::Not(b) => CLabelExpr::Not(Box::new(self.label_expr(b))),
            LabelExpr::And(l, r) => CLabelExpr::And(Box::new(self.label_expr(l)), Box::new(self.label_expr(r))),
            LabelExpr::Or(l, r) => CLabelExpr::Or(Box::new(self.label_expr(l)), Box::new(self.label_expr(r))),
        }
    }

    /// Slot of an in-scope variable, or `UNBOUND` (reads as NULL).
    fn slot_of(&self, name: &str) -> usize {
        self.scope.iter().position(|n| n == name).unwrap_or(UNBOUND)
    }

    /// Add a variable to the current scope (reusing an existing slot if present).
    fn add_var(&mut self, name: &str) -> usize {
        if let Some(i) = self.scope.iter().position(|n| n == name) {
            i
        } else {
            self.scope.push(name.to_string());
            self.scope.len() - 1
        }
    }

    /// Bring every variable a set of patterns introduces into scope (in order),
    /// before lowering the patterns' predicates (which may reference any of them).
    fn add_pattern_vars(&mut self, patterns: &[PathPattern]) {
        for p in patterns {
            if let Some(v) = &p.start.variable {
                self.add_var(v);
            }
            for seg in &p.segments {
                if let Some(v) = &seg.rel.variable {
                    self.add_var(v);
                }
                if let Some(v) = &seg.node.variable {
                    self.add_var(v);
                }
            }
        }
    }

    fn expr(&mut self, e: &Expr) -> CExpr {
        match e {
            Expr::Var(n) => CExpr::Var(self.slot_of(n)),
            Expr::Param(n) => CExpr::Param(self.param_slot(n)),
            Expr::Prop { variable, key } => {
                CExpr::Prop { var_slot: self.slot_of(variable), key_ref: intern_ref(&mut self.keys, key) }
            }
            Expr::Lit(l) => CExpr::Lit(l.clone()),
            Expr::List(items) => CExpr::List(items.iter().map(|x| self.expr(x)).collect()),
            Expr::Compare { op, left, right } => {
                CExpr::Compare { op: *op, left: self.boxed(left), right: self.boxed(right) }
            }
            Expr::Arith { op, left, right } => {
                CExpr::Arith { op: *op, left: self.boxed(left), right: self.boxed(right) }
            }
            Expr::Concat { left, right } => CExpr::Concat { left: self.boxed(left), right: self.boxed(right) },
            Expr::Neg(x) => CExpr::Neg(self.boxed(x)),
            Expr::And(l, r) => CExpr::And(self.boxed(l), self.boxed(r)),
            Expr::Or(l, r) => CExpr::Or(self.boxed(l), self.boxed(r)),
            Expr::Xor(l, r) => CExpr::Xor(self.boxed(l), self.boxed(r)),
            Expr::Not(x) => CExpr::Not(self.boxed(x)),
            Expr::IsNull { expr, negated } => CExpr::IsNull { expr: self.boxed(expr), negated: *negated },
            Expr::IsTruth { expr, truth, negated } => {
                CExpr::IsTruth { expr: self.boxed(expr), truth: *truth, negated: *negated }
            }
            Expr::IsLabeled { expr, label, negated } => {
                CExpr::IsLabeled { expr: self.boxed(expr), label: self.label_expr(label), negated: *negated }
            }
            Expr::In { expr, list, negated } => {
                CExpr::In { expr: self.boxed(expr), list: self.boxed(list), negated: *negated }
            }
            Expr::Exists { patterns, where_ } => {
                let (patterns, where_, sub_len) = self.sub_patterns(patterns, where_.as_deref());
                CExpr::Exists { patterns, where_, sub_len }
            }
            Expr::CountSubquery { patterns, where_ } => {
                let (patterns, where_, sub_len) = self.sub_patterns(patterns, where_.as_deref());
                CExpr::CountSubquery { patterns, where_, sub_len }
            }
            Expr::Case { subject, whens, else_ } => CExpr::Case {
                subject: subject.as_ref().map(|s| self.boxed(s)),
                whens: whens.iter().map(|(w, t)| (self.expr(w), self.expr(t))).collect(),
                else_: else_.as_ref().map(|e| self.boxed(e)),
            },
            Expr::Func { name, args, distinct, star } => {
                let cargs: Vec<CExpr> = args.iter().map(|a| self.expr(a)).collect();
                if let Some(func) = agg_fn(name) {
                    CExpr::Aggregate {
                        func,
                        arg: cargs.into_iter().next().map(Box::new),
                        distinct: *distinct,
                        star: *star,
                    }
                } else {
                    CExpr::Scalar { func: scalar_fn(name), args: cargs }
                }
            }
        }
    }

    fn boxed(&mut self, e: &Expr) -> Box<CExpr> {
        Box::new(self.expr(e))
    }

    /// Lower a correlated sub-query's patterns: extend the scope with the sub's
    /// new variables (outer vars keep their slots — that's the correlation),
    /// lower, then truncate the scope back so the sub's vars don't leak out.
    fn sub_patterns(
        &mut self,
        patterns: &[PathPattern],
        where_: Option<&Expr>,
    ) -> (Vec<CPath>, Option<Box<CExpr>>, usize) {
        let parent_len = self.scope.len();
        self.add_pattern_vars(patterns);
        let cpatterns = patterns.iter().map(|p| self.path(p)).collect();
        let cwhere = where_.map(|w| self.boxed(w));
        let sub_len = self.scope.len();
        self.scope.truncate(parent_len);
        (cpatterns, cwhere, sub_len)
    }

    fn prop(&mut self, p: &PropertyConstraint) -> CPropConstraint {
        CPropConstraint {
            key: p.key.clone(),
            key_ref: intern_ref(&mut self.keys, &p.key),
            value: self.expr(&p.value),
        }
    }

    fn node(&mut self, n: &NodePattern) -> CNode {
        CNode {
            var_slot: n.variable.as_ref().map(|v| self.slot_of(v)),
            label: n.label.as_ref().map(|l| self.label_expr(l)),
            props: n.props.iter().map(|p| self.prop(p)).collect(),
            where_: n.where_.as_ref().map(|w| self.expr(w)),
        }
    }

    fn rel(&mut self, r: &RelPattern) -> CRel {
        CRel {
            var_slot: r.variable.as_ref().map(|v| self.slot_of(v)),
            label: r.label.as_ref().map(|l| self.label_expr(l)),
            direction: r.direction,
            props: r.props.iter().map(|p| self.prop(p)).collect(),
            where_: r.where_.as_ref().map(|w| self.expr(w)),
            quantifier: r.quantifier,
        }
    }

    fn path(&mut self, p: &PathPattern) -> CPath {
        CPath {
            start: self.node(&p.start),
            segments: p
                .segments
                .iter()
                .map(|s| CSegment { rel: self.rel(&s.rel), node: self.node(&s.node) })
                .collect(),
        }
    }

    /// Lower a projection body. Sets the scope for what follows: a non-terminal
    /// (`WITH`) projection's output columns become the next scope; a terminal
    /// (`RETURN`) leaves the scope as-is (nothing follows).
    fn projection(&mut self, p: &Projection, terminal: bool) -> CProjection {
        let input_scope = self.scope.clone();
        let mut aggs: Vec<CAgg> = Vec::new();
        let items: Vec<CReturnItem> = p
            .items
            .iter()
            .map(|it| {
                let expr = self.expr(&it.expr);
                let is_agg = has_aggregate(&expr);
                let name = it.alias.clone().unwrap_or_else(|| column_name(&it.expr));
                // Lift aggregates out of aggregating items so groups fold incrementally.
                let expr = extract_aggs(expr, &mut aggs);
                let prog = compile_program(&expr);
                CReturnItem { expr, prog, name, is_agg }
            })
            .collect();

        let (out_names, star_cols): (Vec<String>, Vec<usize>) = if p.star {
            (input_scope.clone(), (0..input_scope.len()).collect())
        } else {
            (items.iter().map(|i| i.name.clone()).collect(), Vec::new())
        };
        let out_len = out_names.len();
        let aggregating = !p.star && items.iter().any(|i| i.is_agg);

        // ORDER BY scope = output columns, then input vars not shadowed by one.
        let mut sort_scope = out_names.clone();
        let mut order_overlay = Vec::new();
        for (i, name) in input_scope.iter().enumerate() {
            if !out_names.contains(name) {
                sort_scope.push(name.clone());
                order_overlay.push(i);
            }
        }
        self.scope = sort_scope;
        let order_by: Vec<CSortItem> = p
            .order_by
            .iter()
            .map(|s| CSortItem {
                expr: extract_aggs(self.expr(&s.expr), &mut aggs),
                descending: s.descending,
                nulls_first: s.nulls_first,
            })
            .collect();

        self.scope = if terminal { input_scope } else { out_names.clone() };
        let order_needs_output = order_by.iter().any(|s| refs_slot_below(&s.expr, out_len));
        CProjection {
            star: p.star,
            distinct: p.distinct,
            items,
            aggregating,
            aggs,
            out_len,
            out_names,
            star_cols,
            order_by,
            order_overlay,
            order_needs_output,
            skip: p.skip,
            limit: p.limit,
        }
    }

    fn clause(&mut self, c: &Clause) -> CClause {
        match c {
            Clause::Match(m) => {
                self.add_pattern_vars(&m.patterns);
                let patterns = m.patterns.iter().map(|p| self.path(p)).collect();
                let where_ = m.where_.as_ref().map(|w| self.expr(w));
                let where_prog = where_.as_ref().map(compile_program);
                CClause::Match { optional: m.optional, patterns, where_, where_prog, scope_len: self.scope.len() }
            }
            Clause::With(w) => {
                let projection = self.projection(&w.projection, false);
                // WITH's WHERE filters the projected output columns (new scope).
                let where_ = w.where_.as_ref().map(|e| self.expr(e));
                let where_prog = where_.as_ref().map(compile_program);
                CClause::With { projection, where_, where_prog }
            }
            Clause::Return(p) => CClause::Return(self.projection(p, true)),
            Clause::Insert(ps) => {
                self.add_pattern_vars(ps); // INSERT introduces new bindable vars
                CClause::Insert(ps.iter().map(|p| self.path(p)).collect())
            }
            Clause::Set(items) => CClause::Set(
                items
                    .iter()
                    .map(|i| match i {
                        SetItem::Prop { variable, key, value } => {
                            CSetItem::Prop { var_slot: self.slot_of(variable), key: key.clone(), value: self.expr(value) }
                        }
                        SetItem::Label { variable, label } => {
                            CSetItem::Label { var_slot: self.slot_of(variable), label: label.clone() }
                        }
                    })
                    .collect(),
            ),
            Clause::Remove(items) => CClause::Remove(
                items
                    .iter()
                    .map(|i| match i {
                        RemoveItem::Prop { variable, key } => {
                            CRemoveItem::Prop { var_slot: self.slot_of(variable), key: key.clone() }
                        }
                        RemoveItem::Label { variable, label } => {
                            CRemoveItem::Label { var_slot: self.slot_of(variable), label: label.clone() }
                        }
                    })
                    .collect(),
            ),
            Clause::Delete { detach, targets } => {
                CClause::Delete { detach: *detach, targets: targets.iter().map(|t| self.expr(t)).collect() }
            }
            Clause::Finish => CClause::Finish,
        }
    }

    fn linear(&mut self, l: &LinearQuery) -> CLinear {
        self.scope.clear(); // each linear query starts with a fresh scope
        CLinear { clauses: l.clauses.iter().map(|c| self.clause(c)).collect() }
    }
}

/// Lower a parsed query into the IR plus the parameter slot order (slot → name).
pub fn lower(query: &Query) -> (CQuery, Vec<String>) {
    let mut l = Lowerer { params: Vec::new(), scope: Vec::new(), keys: Vec::new(), labels: Vec::new() };
    let parts = query.parts.iter().map(|p| l.linear(p)).collect();
    let cquery = CQuery { parts, ops: query.ops.clone(), key_names: l.keys, label_names: l.labels };
    (cquery, l.params)
}
