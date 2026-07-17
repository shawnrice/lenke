//! Full GQL engine — a faithful Rust port of the TS `@lenke/gql` package,
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
pub mod params;
pub mod parser;
pub mod plan;

#[cfg(test)]
mod ported_gql_hardening;
#[cfg(test)]
mod ported_gql_index_seed;
#[cfg(test)]
mod ported_gql_main;
#[cfg(test)]
mod ported_gql_misc;
#[cfg(test)]
mod ported_gql_operator_chains;
#[cfg(test)]
mod ported_gql_tck;
#[cfg(test)]
mod tests;

pub use eval::{prepare, prepare_with_max_chain, run_invariant, Prepared};
pub use lexer::SyntaxError;
pub use params::params_from_json;
pub use parser::{parse, parse_with_max_chain};
