/// The per-build key that signs state-changing requests (the server's check that a request comes from a real
/// build). Empty in the repository — signing is then off; a release workflow writes the key from its secret
/// into its own checkout and never commits it. The server must hold the same key.
let attestKey = ""
