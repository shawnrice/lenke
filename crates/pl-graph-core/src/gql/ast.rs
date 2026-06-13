//! GQL query AST — a faithful Rust port of the TS `ast.ts`. Plain data only: a
//! parsed query describes *what* to match, never *how*. The surface is the ISO
//! GQL core (`MATCH`/`WHERE`/`RETURN`, ISO ASCII-art patterns, boolean-algebra
//! label expressions, set operators, `WITH`). Comments and semantics track the
//! TS source so the two stay in lockstep.

/// A whole query: one or more linear queries combined by set operators
/// (`p0 UNION p1 EXCEPT p2`, left-associative). `ops[i]` joins `parts[i]` to
/// `parts[i + 1]`, so `ops.len() == parts.len() - 1`.
#[derive(Debug, Clone)]
pub struct Query {
    pub parts: Vec<LinearQuery>,
    pub ops: Vec<SetOp>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SetOpKind {
    Union,
    Except,
    Intersect,
}

/// `UNION` / `EXCEPT` / `INTERSECT`, optionally `ALL` (keep duplicates).
#[derive(Debug, Clone, Copy)]
pub struct SetOp {
    pub op: SetOpKind,
    pub all: bool,
}

/// A linear query: a sequence of clauses ending in `RETURN`/`FINISH`.
#[derive(Debug, Clone)]
pub struct LinearQuery {
    pub clauses: Vec<Clause>,
}

#[derive(Debug, Clone)]
pub enum Clause {
    Match(MatchClause),
    With(WithClause),
    Return(Projection),
    /// `INSERT pattern, …`
    Insert(Vec<PathPattern>),
    /// `SET n.key = v` / `SET n:Label`
    Set(Vec<SetItem>),
    /// `REMOVE n.key` / `REMOVE n:Label`
    Remove(Vec<RemoveItem>),
    /// `[DETACH] DELETE n, …`
    Delete { detach: bool, targets: Vec<Expr> },
    /// `FINISH` — run for side effects, return nothing.
    Finish,
}

/// `[OPTIONAL] MATCH p1, p2, … [WHERE pred]`.
#[derive(Debug, Clone)]
pub struct MatchClause {
    pub optional: bool,
    pub patterns: Vec<PathPattern>,
    pub where_: Option<Expr>,
}

/// `WITH … [WHERE pred]` — a projection that flows into the next clause.
#[derive(Debug, Clone)]
pub struct WithClause {
    pub projection: Projection,
    pub where_: Option<Expr>,
}

#[derive(Debug, Clone)]
pub enum SetItem {
    Prop { variable: String, key: String, value: Expr },
    Label { variable: String, label: String },
}

#[derive(Debug, Clone)]
pub enum RemoveItem {
    Prop { variable: String, key: String },
    Label { variable: String, label: String },
}

/// A linear path pattern: a start node followed by `(rel)(node)` segments.
#[derive(Debug, Clone)]
pub struct PathPattern {
    pub start: NodePattern,
    pub segments: Vec<Segment>,
}

/// One hop: traverse `rel`, land on `node`.
#[derive(Debug, Clone)]
pub struct Segment {
    pub rel: RelPattern,
    pub node: NodePattern,
}

/// `(variable:LabelExpr {props} WHERE pred)` — all parts optional.
#[derive(Debug, Clone, Default)]
pub struct NodePattern {
    pub variable: Option<String>,
    pub label: Option<LabelExpr>,
    pub props: Vec<PropertyConstraint>,
    pub where_: Option<Expr>,
}

/// One `key: valueExpression` entry of a pattern property map.
#[derive(Debug, Clone)]
pub struct PropertyConstraint {
    pub key: String,
    pub value: Expr,
}

/// An ISO label expression (boolean algebra: `A&B`, `A|B`, `!A`, `%`).
#[derive(Debug, Clone)]
pub enum LabelExpr {
    Label(String),
    Wildcard,
    Not(Box<LabelExpr>),
    And(Box<LabelExpr>, Box<LabelExpr>),
    Or(Box<LabelExpr>, Box<LabelExpr>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    Out,
    In,
    Both,
}

/// Variable-length quantifier: `*`={0,∞}, `+`={1,∞}, `{n}`, `{n,m}`.
#[derive(Debug, Clone, Copy)]
pub struct Quantifier {
    pub min: u32,
    pub max: Option<u32>,
}

/// A relationship pattern with a direction (see TS `RelPattern`).
#[derive(Debug, Clone)]
pub struct RelPattern {
    pub variable: Option<String>,
    pub label: Option<LabelExpr>,
    pub direction: Direction,
    pub props: Vec<PropertyConstraint>,
    pub where_: Option<Expr>,
    pub quantifier: Option<Quantifier>,
}

/// A projection body shared by `RETURN` and `WITH`.
#[derive(Debug, Clone)]
pub struct Projection {
    pub star: bool,
    pub items: Vec<ReturnItem>,
    pub distinct: bool,
    pub order_by: Vec<SortItem>,
    pub skip: Option<usize>,
    pub limit: Option<usize>,
}

/// A single RETURN expression with an optional `AS` alias.
#[derive(Debug, Clone)]
pub struct ReturnItem {
    pub expr: Expr,
    pub alias: Option<String>,
}

/// One `ORDER BY` key, with optional ISO `NULLS FIRST` / `NULLS LAST`.
#[derive(Debug, Clone)]
pub struct SortItem {
    pub expr: Expr,
    pub descending: bool,
    /// `Some(true)` = NULLS FIRST, `Some(false)` = NULLS LAST, `None` = default.
    pub nulls_first: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

/// A scalar literal value.
#[derive(Debug, Clone)]
pub enum Lit {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

/// Expression tree (see TS `Expr`). Sub-expressions are boxed.
#[derive(Debug, Clone)]
pub enum Expr {
    Var(String),
    Param(String),
    Prop { variable: String, key: String },
    Lit(Lit),
    List(Vec<Expr>),
    Compare { op: CompareOp, left: Box<Expr>, right: Box<Expr> },
    Arith { op: ArithOp, left: Box<Expr>, right: Box<Expr> },
    Concat { left: Box<Expr>, right: Box<Expr> },
    Neg(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Xor(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    IsNull { expr: Box<Expr>, negated: bool },
    /// `x IS [NOT] TRUE|FALSE|UNKNOWN` — `truth` is the target (`None` = UNKNOWN).
    IsTruth { expr: Box<Expr>, truth: Option<bool>, negated: bool },
    /// `x IS [NOT] LABELED <label expression>`.
    IsLabeled { expr: Box<Expr>, label: LabelExpr, negated: bool },
    In { expr: Box<Expr>, list: Box<Expr>, negated: bool },
    /// `EXISTS { p1, … [WHERE pred] }` — correlated sub-pattern existence.
    Exists { patterns: Vec<PathPattern>, where_: Option<Box<Expr>> },
    /// `COUNT { p1, … [WHERE pred] }` — correlated sub-pattern match count.
    CountSubquery { patterns: Vec<PathPattern>, where_: Option<Box<Expr>> },
    /// ISO CASE: `subject` present → simple CASE, else searched.
    Case { subject: Option<Box<Expr>>, whens: Vec<(Expr, Expr)>, else_: Option<Box<Expr>> },
    Func { name: String, args: Vec<Expr>, distinct: bool, star: bool },
}
