//! Request signing («build attestation»): the `X-Linea-Attest` header.
//!
//! Reference: `server/src/attest.js` (the verifier) and `mobile/src/attest` (the app side).
//! The header is `<unix-seconds>.<hex>` where `hex = HMAC-SHA256(key, "<ts>\n<METHOD>\n<path with query>")`.
//! The key is given by the build, never stored in the source. This is a rotatable bar against casual forks,
//! not a secret channel: authentication and end-to-end encryption do the real work.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// The text that is signed.
pub fn payload(ts: u64, method: &str, url: &str) -> String {
    format!("{ts}\n{}\n{url}", method.to_uppercase())
}

/// The signature alone, lower-case hex.
pub fn sign(key: &str, ts: u64, method: &str, url: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(payload(ts, method, url).as_bytes());
    mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The header value, or `None` when the build carries no key (the header is then not sent at all).
pub fn header(key: &str, ts: u64, method: &str, url: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    Some(format!("{ts}.{}", sign(key, ts, method, url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_key_no_header() {
        assert_eq!(header("", 1_700_000_000, "POST", "/chats"), None);
    }

    #[test]
    fn method_is_upper_cased_in_the_payload() {
        assert_eq!(payload(1, "post", "/a?b=1"), "1\nPOST\n/a?b=1");
    }
}
