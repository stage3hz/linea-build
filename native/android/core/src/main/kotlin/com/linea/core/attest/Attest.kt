package com.linea.core.attest

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Signs state-changing requests with a per-build key so the server can turn away requests that are not from a
 * real INVIZENT build (server: attest.js). The key ships inside the app and can be extracted: this is a
 * rotatable gate, not a secret channel. Authentication and end-to-end encryption do the real work.
 *
 * The key is injected by the release build and is never in the repository; an empty key turns signing off.
 */
class Attest(private val key: String) {
    /** `X-Linea-Attest` for a state-changing request; empty for reads and when this build has no key. */
    fun headers(method: String, pathWithQuery: String, nowMs: Long): Map<String, String> {
        val verb = method.ifEmpty { "GET" }.uppercase()
        if (key.isEmpty() || verb == "GET" || verb == "HEAD") return emptyMap()
        val ts = Math.floorDiv(nowMs, 1000L)
        return mapOf(HEADER to "$ts.${hmacSha256Hex(key, "$ts\n$verb\n$pathWithQuery")}")
    }

    companion object {
        const val HEADER = "X-Linea-Attest"

        fun hmacSha256Hex(key: String, message: String): String {
            // The reference encodes text itself and writes a lone surrogate as its three UTF-8 bytes; the JDK
            // would write «?». Neither a key nor a request path ever has one, so it is refused rather than guessed.
            val keyBytes = wellFormedUtf8(key)
            val mac = Mac.getInstance("HmacSHA256")
            // An empty key is valid for HMAC but not for SecretKeySpec; a zero block is the same key.
            mac.init(SecretKeySpec(if (keyBytes.isEmpty()) ByteArray(1) else keyBytes, "HmacSHA256"))
            return mac.doFinal(wellFormedUtf8(message)).joinToString("") { "%02x".format(it) }
        }

        private fun wellFormedUtf8(text: String): ByteArray {
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) i++
                else require(!Character.isSurrogate(c)) { "Text with a lone surrogate cannot be signed." }
                i++
            }
            return text.toByteArray(Charsets.UTF_8)
        }
    }
}
