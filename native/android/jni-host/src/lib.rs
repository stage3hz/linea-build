//! The very file the Android library is built from, compiled here against the core as a dependency.
mod ffi { pub use invizent_core::ffi::*; }
#[path = "../../../core/src/jni.rs"]
mod jni;
