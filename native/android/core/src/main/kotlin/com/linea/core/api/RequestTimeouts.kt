package com.linea.core.api

import com.linea.core.network.NetworkTier
import com.linea.core.network.QualityRules
import com.linea.core.network.RequestKind

object RequestTimeouts {
    // Sign-in, recovery and secret changes hash secrets with scrypt on the server and queue behind other password
    // jobs: under load a short limit cut off a sign-up the server then completed. Those POSTs get 45 s.
    private val PASSWORD_ROUTES = Regex("""^/auth/(?:login|register|recovery/(?:verify|reset)|password|confirmation-word|recovery-word)$""")
    private val UPLOAD_CHUNK = Regex("""^/(?:e2ee/)?uploads/""")
    private val MESSAGES = Regex("""/messages(\?|$)""")

    /** Ordinary limits grow on slow links (EDGE/3G), so a message is not cut off half-way. */
    fun forRequest(path: String, method: String, tier: NetworkTier, testBuild: Boolean = false): Long {
        val bare = path.substringBefore('?')
        if (method == "POST" && PASSWORD_ROUTES.containsMatchIn(bare)) {
            return if (testBuild) 240_000L
            else Math.round(45_000.0 * QualityRules.timeoutFor(RequestKind.READ, tier) / QualityRules.timeoutFor(RequestKind.READ, NetworkTier.FAST))
        }
        val kind = when {
            bare == "/uploads" || bare == "/e2ee/files" || (method == "PUT" && UPLOAD_CHUNK.containsMatchIn(bare)) -> RequestKind.UPLOAD
            method != "GET" && MESSAGES.containsMatchIn(path) -> RequestKind.SEND
            else -> RequestKind.READ
        }
        return QualityRules.timeoutFor(kind, tier)
    }
}
