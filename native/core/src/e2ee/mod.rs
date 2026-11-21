//! The logic around end-to-end encryption.
//!
//! Reference: `mobile/src/e2ee/core.ts`. The cryptography itself — the Signal protocol — is the official library
//! on each platform, behind a narrow interface; this is everything around it: what an encrypted message must look
//! like, its canonical form, who is trusted, what is sent to whom and what is remembered. It is ported exactly:
//! the same protocol, the same formats, the same refusals.

pub mod attachment;
pub mod bridge;
pub mod dispatch;
pub mod files;
pub mod service;
pub mod wire;
