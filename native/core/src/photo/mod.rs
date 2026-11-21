//! Photos as they travel inside an encrypted message.
//!
//! Reference: `mobile/src/photo/jpeg.ts`, `mobile/src/photo/jpegHdr.ts` and `mobile/src/media/previewModel.ts`,
//! only as far as `validPreview` reaches into them. Pinned by `tests/preview_vectors.rs`, whose verdicts come
//! from running the reference (`tests/generate-preview-vectors.mjs`).

pub mod jpeg;
pub mod jpeg_hdr;
pub mod preview;

pub use preview::valid_preview;
