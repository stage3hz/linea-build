package com.linea.core.servers

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Ed25519 by the platform's own provider (JDK 15+, Android 13+). On an older Android the provider is missing and
 * every list is refused — the app then simply stays on its built-in servers.
 */
object Ed25519Verifier : ListSignatureVerifier {
    /** DER header of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
    private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        return try {
            val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + publicKey))
            Signature.getInstance("Ed25519").run { initVerify(key); update(message); verify(signature) }
        } catch (_: Exception) {
            false
        }
    }
}
