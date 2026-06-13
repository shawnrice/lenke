//! Full GQL engine — a faithful Rust port of the TS `@pl-graph/gql` package,
//! operating over the columnar [`Graph`](crate::graph::Graph). The TS tests are
//! the conformance spec.
//!
//! Layers mirror the TS source: [`ast`] (the contract), [`lexer`], [`parser`],
//! the lowered IR in [`plan`], and the evaluator/executor in [`eval`].
//!
//! Two entry points, both returning a [`crate::query::RowSet`]:
//! - [`prepare`] → a [`Prepared`] plan: lex + parse + lower once, then execute
//!   many times with different params (slotted positionally) against any graph.
//! - [`parse`] + [`Query::execute`] — the one-shot convenience (lowers each run).
//!
//! Vertex *and* edge properties are fully supported and the graph is mutable, so
//! read and write clauses (`INSERT/SET/REMOVE/DELETE`) all work.

pub mod ast;
pub mod eval;
pub mod lexer;
pub mod parser;
pub mod plan;

#[cfg(test)]
mod tests;

pub use eval::{prepare, Prepared};
pub use lexer::SyntaxError;
pub use parser::parse;
