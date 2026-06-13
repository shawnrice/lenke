//! Full GQL engine — a faithful Rust port of the TS `@pl-graph/gql` package,
//! operating over the columnar [`Graph`](crate::graph::Graph). The TS tests are
//! the conformance spec.
//!
//! Layers mirror the TS source: [`ast`] (the contract), [`lexer`], [`parser`],
//! and the evaluator/executor in [`eval`]. The public surface is [`parse`] +
//! [`Query::execute`], returning a [`crate::query::RowSet`].
//!
//! Columnar-core boundary: **write clauses** (`INSERT/SET/REMOVE/DELETE`) are
//! rejected — the core is build-once immutable. Vertex *and* edge properties are
//! fully supported (both read from the same columnar [`Properties`] store).
//!
//! [`Properties`]: crate::graph::Properties

pub mod ast;
pub mod eval;
pub mod lexer;
pub mod parser;

#[cfg(test)]
mod tests;

pub use lexer::SyntaxError;
pub use parser::parse;
