//! A small GQL subset: `MATCH` a linear pattern, optional single `WHERE`
//! comparison, `RETURN count(*)` or a projected item. Enough to run the
//! benchmark queries through a real parser+executor over the columnar core.
//!
//! Every query reduces to a `(count, sum)` signature: row count, plus the sum
//! of a numeric projection (0 for count/non-numeric). That's an order-
//! independent fingerprint the TS and Rust engines can be checked equal on.

use crate::graph::{Column, Graph};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

#[derive(Debug, Clone)]
enum Lit {
    Num(f64),
    Str(String),
    Bool(bool),
}

#[derive(Debug, Clone)]
struct NodeP {
    var: Option<String>,
    label: Option<String>,
}

#[derive(Debug, Clone)]
struct RelP {
    etype: Option<String>,
}

#[derive(Debug, Clone)]
struct Pred {
    var: String,
    key: String,
    op: Op,
    lit: Lit,
}

#[derive(Debug, Clone)]
enum Ret {
    Count,
    Item { var: String, key: Option<String> },
}

#[derive(Debug, Clone)]
pub struct Query {
    nodes: Vec<NodeP>,
    rels: Vec<RelP>, // rels[i] connects nodes[i] -> nodes[i+1]
    pred: Option<Pred>,
    ret: Ret,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QueryResult {
    pub count: u64,
    pub sum: f64,
}

// ---------- tokenizer ----------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Num(f64),
    Str(String),
    Sym(String), // punctuation incl. multi-char ops like -[ ]-> <= >= <>
}

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i] as char;
        if c.is_whitespace() {
            i += 1;
        } else if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            let start = i;
            while i < b.len() && b[i] as char != quote {
                i += 1;
            }
            out.push(Tok::Str(s[start..i].to_string()));
            i += 1; // closing quote
        } else if c.is_ascii_digit() || (c == '-' && i + 1 < b.len() && (b[i + 1] as char).is_ascii_digit()) {
            let start = i;
            i += 1;
            while i < b.len() && {
                let d = b[i] as char;
                d.is_ascii_digit() || d == '.'
            } {
                i += 1;
            }
            out.push(Tok::Num(s[start..i].parse().map_err(|_| "bad number")?));
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < b.len() && {
                let d = b[i] as char;
                d.is_alphanumeric() || d == '_'
            } {
                i += 1;
            }
            out.push(Tok::Ident(s[start..i].to_string()));
        } else {
            // multi-char operators
            let two = if i + 1 < b.len() { &s[i..i + 2] } else { "" };
            let three = if i + 2 < b.len() { &s[i..i + 3] } else { "" };
            if three == "]->" {
                out.push(Tok::Sym("]->".into()));
                i += 3;
            } else if two == "-[" {
                out.push(Tok::Sym("-[".into()));
                i += 2;
            } else if two == "->" {
                out.push(Tok::Sym("->".into()));
                i += 2;
            } else if two == "<=" || two == ">=" || two == "<>" {
                out.push(Tok::Sym(two.into()));
                i += 2;
            } else {
                out.push(Tok::Sym((c).to_string()));
                i += 1;
            }
        }
    }
    Ok(out)
}

// ---------- parser (recursive descent) ----------

struct P {
    toks: Vec<Tok>,
    i: usize,
}

impl P {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }
    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.i).cloned();
        self.i += 1;
        t
    }
    fn eat_sym(&mut self, s: &str) -> Result<(), String> {
        match self.next() {
            Some(Tok::Sym(x)) if x == s => Ok(()),
            other => Err(format!("expected '{s}', got {other:?}")),
        }
    }
    fn eat_kw(&mut self, kw: &str) -> Result<(), String> {
        match self.next() {
            Some(Tok::Ident(x)) if x.eq_ignore_ascii_case(kw) => Ok(()),
            other => Err(format!("expected '{kw}', got {other:?}")),
        }
    }
    fn is_kw(&self, kw: &str) -> bool {
        matches!(self.peek(), Some(Tok::Ident(x)) if x.eq_ignore_ascii_case(kw))
    }

    fn node(&mut self) -> Result<NodeP, String> {
        self.eat_sym("(")?;
        let mut var = None;
        let mut label = None;
        if let Some(Tok::Ident(v)) = self.peek() {
            var = Some(v.clone());
            self.next();
        }
        if matches!(self.peek(), Some(Tok::Sym(s)) if s == ":") {
            self.next();
            match self.next() {
                Some(Tok::Ident(l)) => label = Some(l),
                other => return Err(format!("expected label, got {other:?}")),
            }
        }
        self.eat_sym(")")?;
        Ok(NodeP { var, label })
    }

    fn rel(&mut self) -> Result<RelP, String> {
        self.eat_sym("-[")?;
        let mut etype = None;
        if matches!(self.peek(), Some(Tok::Sym(s)) if s == ":") {
            self.next();
            match self.next() {
                Some(Tok::Ident(t)) => etype = Some(t),
                other => return Err(format!("expected edge type, got {other:?}")),
            }
        }
        self.eat_sym("]->")?;
        Ok(RelP { etype })
    }

    fn op(&mut self) -> Result<Op, String> {
        match self.next() {
            Some(Tok::Sym(s)) => match s.as_str() {
                "=" => Ok(Op::Eq),
                "<>" => Ok(Op::Ne),
                "<" => Ok(Op::Lt),
                ">" => Ok(Op::Gt),
                "<=" => Ok(Op::Le),
                ">=" => Ok(Op::Ge),
                _ => Err(format!("bad operator {s}")),
            },
            other => Err(format!("expected operator, got {other:?}")),
        }
    }

    fn lit(&mut self) -> Result<Lit, String> {
        match self.next() {
            Some(Tok::Num(n)) => Ok(Lit::Num(n)),
            Some(Tok::Str(s)) => Ok(Lit::Str(s)),
            Some(Tok::Ident(x)) if x.eq_ignore_ascii_case("true") => Ok(Lit::Bool(true)),
            Some(Tok::Ident(x)) if x.eq_ignore_ascii_case("false") => Ok(Lit::Bool(false)),
            other => Err(format!("expected literal, got {other:?}")),
        }
    }

    fn parse(&mut self) -> Result<Query, String> {
        self.eat_kw("MATCH")?;
        let mut nodes = vec![self.node()?];
        let mut rels = Vec::new();
        while matches!(self.peek(), Some(Tok::Sym(s)) if s == "-[") {
            rels.push(self.rel()?);
            nodes.push(self.node()?);
        }
        let mut pred = None;
        if self.is_kw("WHERE") {
            self.next();
            let var = match self.next() {
                Some(Tok::Ident(v)) => v,
                other => return Err(format!("expected var in WHERE, got {other:?}")),
            };
            self.eat_sym(".")?;
            let key = match self.next() {
                Some(Tok::Ident(k)) => k,
                other => return Err(format!("expected key in WHERE, got {other:?}")),
            };
            let op = self.op()?;
            let lit = self.lit()?;
            pred = Some(Pred { var, key, op, lit });
        }
        self.eat_kw("RETURN")?;
        let ret = if self.is_kw("count") {
            self.next();
            self.eat_sym("(")?;
            self.eat_sym("*")?;
            self.eat_sym(")")?;
            Ret::Count
        } else {
            let var = match self.next() {
                Some(Tok::Ident(v)) => v,
                other => return Err(format!("expected RETURN item, got {other:?}")),
            };
            let mut key = None;
            if matches!(self.peek(), Some(Tok::Sym(s)) if s == ".") {
                self.next();
                match self.next() {
                    Some(Tok::Ident(k)) => key = Some(k),
                    other => return Err(format!("expected key, got {other:?}")),
                }
            }
            Ret::Item { var, key }
        };
        Ok(Query { nodes, rels, pred, ret })
    }
}

pub fn parse(s: &str) -> Result<Query, String> {
    let mut p = P { toks: tokenize(s)?, i: 0 };
    p.parse()
}

// ---------- executor ----------

fn num_col<'a>(g: &'a Graph, key: &str) -> Option<&'a Column> {
    g.keys.get(key).and_then(|kid| g.cols.get(&kid))
}

fn vertex_num(g: &Graph, vi: u32, key: &str) -> Option<f64> {
    match num_col(g, key)? {
        Column::Num { data, present } if present.get(vi as usize) => Some(data[vi as usize]),
        _ => None,
    }
}

fn pred_holds(g: &Graph, vi: u32, p: &Pred) -> bool {
    match &p.lit {
        Lit::Num(threshold) => match vertex_num(g, vi, &p.key) {
            Some(x) => match p.op {
                Op::Eq => x == *threshold,
                Op::Ne => x != *threshold,
                Op::Lt => x < *threshold,
                Op::Gt => x > *threshold,
                Op::Le => x <= *threshold,
                Op::Ge => x >= *threshold,
            },
            None => false,
        },
        Lit::Str(s) => {
            let want = g.strs.get(s);
            let got = match num_col(g, &p.key) {
                Some(Column::Str { data, present }) if present.get(vi as usize) => Some(data[vi as usize]),
                _ => None,
            };
            match (p.op, want, got) {
                (Op::Eq, Some(w), Some(gt)) => w == gt,
                (Op::Ne, Some(w), Some(gt)) => w != gt,
                _ => false,
            }
        }
        Lit::Bool(b) => match num_col(g, &p.key) {
            Some(Column::Bool { data, present }) if present.get(vi as usize) => {
                let v = data[vi as usize];
                match p.op {
                    Op::Eq => v == *b,
                    Op::Ne => v != *b,
                    _ => false,
                }
            }
            _ => false,
        },
    }
}

/// Seed vertices for node 0: its label bucket, or all vertices.
fn seeds<'a>(g: &'a Graph, node: &NodeP) -> Box<dyn Iterator<Item = u32> + 'a> {
    match node.label.as_ref().and_then(|l| g.labels.get(l)) {
        Some(lid) => Box::new(g.vertices_with_label(lid).iter().copied()),
        None if node.label.is_some() => Box::new(std::iter::empty()),
        None => Box::new(0..g.n as u32),
    }
}

impl Query {
    /// Index of the variable named `name` among the pattern nodes.
    fn var_pos(&self, name: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.var.as_deref() == Some(name))
    }

    pub fn run(&self, g: &Graph) -> QueryResult {
        let label_ids: Vec<Option<u32>> =
            self.nodes.iter().map(|nd| nd.label.as_ref().and_then(|l| g.labels.get(l))).collect();
        let etype_ids: Vec<Option<u32>> =
            self.rels.iter().map(|r| r.etype.as_ref().and_then(|t| g.etype.get(t))).collect();
        // A label that doesn't exist in the dict means zero matches.
        for (nd, lid) in self.nodes.iter().zip(&label_ids) {
            if nd.label.is_some() && lid.is_none() {
                return QueryResult { count: 0, sum: 0.0 };
            }
        }
        let pred_pos = self.pred.as_ref().and_then(|p| self.var_pos(&p.var));
        let proj_pos = match &self.ret {
            Ret::Item { var, .. } => self.var_pos(var),
            Ret::Count => None,
        };
        let proj_key = match &self.ret {
            Ret::Item { key, .. } => key.clone(),
            Ret::Count => None,
        };

        let mut count: u64 = 0;
        let mut sum: f64 = 0.0;
        let mut binding = vec![0u32; self.nodes.len()];

        // DFS over the linear pattern.
        let mut stack: Vec<(usize, u32)> = Vec::new();
        for s in seeds(g, &self.nodes[0]) {
            stack.push((0, s));
            while let Some((depth, v)) = stack.pop() {
                // label check for this position
                if let Some(lid) = label_ids[depth] {
                    if !g.has_label(v, lid) {
                        continue;
                    }
                }
                binding[depth] = v;
                if depth + 1 == self.nodes.len() {
                    // full match — apply WHERE, then project.
                    if let (Some(pp), Some(p)) = (pred_pos, self.pred.as_ref()) {
                        if !pred_holds(g, binding[pp], p) {
                            continue;
                        }
                    }
                    count += 1;
                    if let (Some(pp), Some(k)) = (proj_pos, proj_key.as_ref()) {
                        if let Some(x) = vertex_num(g, binding[pp], k) {
                            sum += x;
                        }
                    }
                } else {
                    let et = etype_ids[depth];
                    // If the rel type was named but absent, no neighbors match.
                    if self.rels[depth].etype.is_some() && et.is_none() {
                        continue;
                    }
                    for nbr in g.out_neighbors(v, et) {
                        stack.push((depth + 1, nbr));
                    }
                }
            }
        }
        QueryResult { count, sum }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ndjson;

    fn fixture() -> Graph {
        let input = "\
{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"Person\"],\"properties\":{\"age\":30}}
{\"type\":\"node\",\"id\":\"b\",\"labels\":[\"Person\"],\"properties\":{\"age\":60}}
{\"type\":\"node\",\"id\":\"c\",\"labels\":[\"Person\"],\"properties\":{\"age\":70}}
{\"type\":\"edge\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"KNOWS\"]}
{\"type\":\"edge\",\"from\":\"b\",\"to\":\"c\",\"labels\":[\"KNOWS\"]}";
        ndjson::decode(input)
    }

    #[test]
    fn count_label_scan() {
        let g = fixture();
        assert_eq!(parse("MATCH (a:Person) RETURN count(*)").unwrap().run(&g).count, 3);
    }

    #[test]
    fn filter_and_project() {
        let g = fixture();
        let r = parse("MATCH (a:Person) WHERE a.age > 50 RETURN a.age").unwrap().run(&g);
        assert_eq!(r.count, 2); // 60, 70
        assert_eq!(r.sum, 130.0);
    }

    #[test]
    fn one_and_two_hop() {
        let g = fixture();
        let r1 = parse("MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN count(*)").unwrap().run(&g);
        assert_eq!(r1.count, 2); // a->b, b->c
        let r2 = parse("MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN count(*)")
            .unwrap()
            .run(&g);
        assert_eq!(r2.count, 1); // a->b->c
    }
}
