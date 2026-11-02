// Per-build request-signing key. The public repository always ships it EMPTY,
// which turns request signing off. Release builds overwrite this file in their
// own workspace (scripts/inject-attest-key.mjs, from the ATTEST_KEY secret) and
// never commit it back. The server must use the same key (deploy/.env ATTEST_KEY).
export const ATTEST_KEY = '';
