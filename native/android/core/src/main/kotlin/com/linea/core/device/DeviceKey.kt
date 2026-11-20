package com.linea.core.device

import java.math.BigInteger
import java.security.interfaces.ECPublicKey
import java.util.Base64

enum class DeviceKeyKind(val wire: String) { HARDWARE("hardware"), SOFTWARE("software") }

/** The public key (base64url of the 65-byte P-256 point 04 ‖ X ‖ Y) and where the private one lives. */
data class DeviceKeyInfo(val publicKey: String, val kind: DeviceKeyKind)

/**
 * The key this device's sessions are bound to. On a phone the private key lives in the Android Keystore and never
 * leaves it; this interface is all the session code knows about it.
 */
interface DeviceKey {
    suspend fun ensure(): DeviceKeyInfo

    /** ECDSA P-256 / SHA-256 over the message's UTF-8 bytes, DER, base64url without padding. */
    suspend fun sign(message: String): String
}

/** Thrown by [DeviceKey.sign] when the chip no longer holds the key a session was bound to: not a passing failure. */
class DeviceKeyChangedException(message: String = "key changed") : Exception(message)

object DeviceKeyEncoding {
    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** The public key as the server takes it: base64url of 04 ‖ X ‖ Y, each coordinate 32 bytes. */
    fun publicPoint(key: ECPublicKey): String =
        base64Url(byteArrayOf(4) + fixed32(key.w.affineX) + fixed32(key.w.affineY))

    private fun fixed32(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        val out = ByteArray(32)
        val take = minOf(32, bytes.size)
        System.arraycopy(bytes, bytes.size - take, out, 32 - take, take)
        return out
    }
}
