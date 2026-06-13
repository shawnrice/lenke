//! The lowered intermediate representation (IR) and the `lower` pass.
//!
//! A parsed [`Query`](super::ast::Query) is *lowered* once into a `CQuery` that
//! bakes every graph- and param-independent decision: `$param` → a positional
//! slot, function name → an enum, aggregate detection, projection column names
//! and group keys. This is the artifact a prepared statement holds, so the
//! analysis is paid once and reused across executions (the executor walks the IR
//! with a cheap `match`, no per-row string work for params/functions).
//!
//! Resolutions that depend on a specific graph (property key → id) are NOT done
//! here — the graph is mutable and key ids are graph-specific, so those stay at
//! execute time. Variable access is still name-keyed (slot allocation is a
//! follow-up); everything else is resolved.

use super::ast::*;

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

/// Lowered expression. Mirrors [`Expr`] but with `$param` resolved to a slot and
/// function calls resolved to `Scalar`/`Aggregate` with enum tags. Variable and
/// property access stay name-keyed (binding-slot allocation is a follow-up).
#[derive(Debug, Clone)]
pub enum CExpr {
    Var(String),
    Param(usize),
    Prop { var: String, key: String },
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
    IsLabeled { expr: Box<CExpr>, label: LabelExpr, negated: bool },
    In { expr: Box<CExpr>, list: Box<CExpr>, negated: bool },
    Exists { patterns: Vec<CPath>, where_: Option<Box<CExpr>> },
    CountSubquery { patterns: Vec<CPath>, where_: Option<Box<CExpr>> },
    Case { subject: Option<Box<CExpr>>, whens: Vec<(CExpr, CExpr)>, else_: Option<Box<CExpr>> },
    Scalar { func: ScalarFn, args: Vec<CExpr> },
    Aggregate { func: AggFn, arg: Option<Box<CExpr>>, distinct: bool, star: bool },
}

#[derive(Debug, Clone)]
pub struct CPropConstraint {
    pub key: String,
    pub value: CExpr,
}

#[derive(Debug, Clone)]
pub struct CNode {
    pub variable: Option<String>,
    pub label: Option<LabelExpr>,
    pub props: Vec<CPropConstraint>,
    pub where_: Option<CExpr>,
}

#[derive(Debug, Clone)]
pub struct CRel {
    pub variable: Option<String>,
    pub label: Option<LabelExpr>,
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
    /// The output column name (alias, or derived from the expression).
    pub name: String,
    /// Whether this item contains an aggregate (a non-grouping column).
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
    pub order_by: Vec<CSortItem>,
    pub skip: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum CSetItem {
    Prop { variable: String, key: String, value: CExpr },
    Label { variable: String, label: String },
}

#[derive(Debug, Clone)]
pub enum CClause {
    Match { optional: bool, patterns: Vec<CPath>, where_: Option<CExpr> },
    With { projection: CProjection, where_: Option<CExpr> },
    Return(CProjection),
    Insert(Vec<CPath>),
    Set(Vec<CSetItem>),
    Remove(Vec<RemoveItem>),
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
}

/// Does a lowered expression contain an aggregate anywhere?
pub fn has_aggregate(expr: &CExpr) -> bool {
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

/// The default output column name for a lowered item with no `AS` alias.
fn column_name(expr: &CExpr) -> String {
    match expr {
        CExpr::Var(name) => name.clone(),
        CExpr::Prop { var, key } => format!("{var}.{key}"),
        _ => "expr".to_string(),
    }
}

/// Lowers a `Query` to a `CQuery`, allocating `$param` slots in first-use order.
struct Lowerer {
    /// param slot -> name (the order positional args are bound in at execute).
    params: Vec<String>,
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

    fn expr(&mut self, e: &Expr) -> CExpr {
        match e {
            Expr::Var(n) => CExpr::Var(n.clone()),
            Expr::Param(n) => CExpr::Param(self.param_slot(n)),
            Expr::Prop { variable, key } => CExpr::Prop { var: variable.clone(), key: key.clone() },
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
                CExpr::IsLabeled { expr: self.boxed(expr), label: label.clone(), negated: *negated }
            }
            Expr::In { expr, list, negated } => {
                CExpr::In { expr: self.boxed(expr), list: self.boxed(list), negated: *negated }
            }
            Expr::Exists { patterns, where_ } => CExpr::Exists {
                patterns: patterns.iter().map(|p| self.path(p)).collect(),
                where_: where_.as_ref().map(|w| self.boxed(w)),
            },
            Expr::CountSubquery { patterns, where_ } => CExpr::CountSubquery {
                patterns: patterns.iter().map(|p| self.path(p)).collect(),
                where_: where_.as_ref().map(|w| self.boxed(w)),
            },
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

    fn prop(&mut self, p: &PropertyConstraint) -> CPropConstraint {
        CPropConstraint { key: p.key.clone(), value: self.expr(&p.value) }
    }

    fn node(&mut self, n: &NodePattern) -> CNode {
        CNode {
            variable: n.variable.clone(),
            label: n.label.clone(),
            props: n.props.iter().map(|p| self.prop(p)).collect(),
            where_: n.where_.as_ref().map(|w| self.expr(w)),
        }
    }

    fn rel(&mut self, r: &RelPattern) -> CRel {
        CRel {
            variable: r.variable.clone(),
            label: r.label.clone(),
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

    fn projection(&mut self, p: &Projection) -> CProjection {
        let items: Vec<CReturnItem> = p
            .items
            .iter()
            .map(|it| {
                let expr = self.expr(&it.expr);
                let is_agg = has_aggregate(&expr);
                let name = it.alias.clone().unwrap_or_else(|| column_name(&expr));
                CReturnItem { expr, name, is_agg }
            })
            .collect();
        let aggregating = !p.star && items.iter().any(|i| i.is_agg);
        let order_by = p
            .order_by
            .iter()
            .map(|s| CSortItem { expr: self.expr(&s.expr), descending: s.descending, nulls_first: s.nulls_first })
            .collect();
        CProjection { star: p.star, distinct: p.distinct, items, aggregating, order_by, skip: p.skip, limit: p.limit }
    }

    fn clause(&mut self, c: &Clause) -> CClause {
        match c {
            Clause::Match(m) => CClause::Match {
                optional: m.optional,
                patterns: m.patterns.iter().map(|p| self.path(p)).collect(),
                where_: m.where_.as_ref().map(|w| self.expr(w)),
            },
            Clause::With(w) => {
                CClause::With { projection: self.projection(&w.projection), where_: w.where_.as_ref().map(|e| self.expr(e)) }
            }
            Clause::Return(p) => CClause::Return(self.projection(p)),
            Clause::Insert(ps) => CClause::Insert(ps.iter().map(|p| self.path(p)).collect()),
            Clause::Set(items) => CClause::Set(
                items
                    .iter()
                    .map(|i| match i {
                        SetItem::Prop { variable, key, value } => {
                            CSetItem::Prop { variable: variable.clone(), key: key.clone(), value: self.expr(value) }
                        }
                        SetItem::Label { variable, label } => {
                            CSetItem::Label { variable: variable.clone(), label: label.clone() }
                        }
                    })
                    .collect(),
            ),
            Clause::Remove(items) => CClause::Remove(items.clone()),
            Clause::Delete { detach, targets } => {
                CClause::Delete { detach: *detach, targets: targets.iter().map(|t| self.expr(t)).collect() }
            }
            Clause::Finish => CClause::Finish,
        }
    }

    fn linear(&mut self, l: &LinearQuery) -> CLinear {
        CLinear { clauses: l.clauses.iter().map(|c| self.clause(c)).collect() }
    }
}

/// Lower a parsed query into the IR plus the parameter slot order (slot → name).
pub fn lower(query: &Query) -> (CQuery, Vec<String>) {
    let mut l = Lowerer { params: Vec::new() };
    let parts = query.parts.iter().map(|p| l.linear(p)).collect();
    (CQuery { parts, ops: query.ops.clone() }, l.params)
}
