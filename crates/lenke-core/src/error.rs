//! A structured error carrying a stable [`ErrorCode`](crate::error_codes::ErrorCode)
//! alongside its human message — the Rust mirror of the TS `LenkeError`
//! contract. Subsystems (codec, and later the GQL engine) return this so the FFI
//! layer surfaces the precise code directly, instead of guessing a coarse
//! default from an opaque `String`.
//!
//! The message stays free to change; the **code is the contract** (it crosses
//! the FFI boundary verbatim). See `error_codes.rs` for the shared code list.

use crate::error_codes::ErrorCode;

/// A failure with a stable code and a human-readable message.
#[derive(Debug, Clone)]
pub struct CodeError {
    pub code: ErrorCode,
    pub message: String,
}

impl CodeError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// `Result` specialized to a coded error.
pub type CodeResult<T> = Result<T, CodeError>;
