package com.linea.core.model

import com.linea.core.json.JsonArray
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonValue
import com.linea.core.json.array
import com.linea.core.json.asArray
import com.linea.core.json.asInt
import com.linea.core.json.asObject
import com.linea.core.json.asString
import com.linea.core.json.booleanOrNull
import com.linea.core.json.int
import com.linea.core.json.intOrNull
import com.linea.core.json.json
import com.linea.core.json.jsonObject
import com.linea.core.json.obj
import com.linea.core.json.requireObject
import com.linea.core.json.string
import com.linea.core.json.stringOrNull

// The public key material and envelopes of the Signal-based protocol, exactly as they travel (e2ee/types.ts).
// Field order in toJson() is the order the reference builds these objects in.

data class PublicPreKey(val id: Int, val publicKey: String) {
    fun toJson(): JsonObject = jsonObject("id" to id.json(), "publicKey" to publicKey.json())

    companion object {
        fun fromJson(json: JsonObject) = PublicPreKey(json.int("id"), json.string("publicKey"))
    }
}

data class PublicSignedPreKey(val id: Int, val publicKey: String, val signature: String) {
    fun toJson(): JsonObject = jsonObject("id" to id.json(), "publicKey" to publicKey.json(), "signature" to signature.json())

    companion object {
        fun fromJson(json: JsonObject) = PublicSignedPreKey(json.int("id"), json.string("publicKey"), json.string("signature"))
    }
}

data class PublicBundle(
    val registrationId: Int,
    val identityKey: String,
    val signedPreKey: PublicSignedPreKey,
    val kyberPreKey: PublicSignedPreKey,
    val preKeys: List<PublicPreKey>,
) {
    fun toJson(): JsonObject = jsonObject(
        "registrationId" to registrationId.json(),
        "identityKey" to identityKey.json(),
        "signedPreKey" to signedPreKey.toJson(),
        "kyberPreKey" to kyberPreKey.toJson(),
        "preKeys" to JsonArray(preKeys.map { it.toJson() }),
    )

    companion object {
        fun fromJson(json: JsonObject) = PublicBundle(
            json.int("registrationId"), json.string("identityKey"),
            PublicSignedPreKey.fromJson(json.obj("signedPreKey")), PublicSignedPreKey.fromJson(json.obj("kyberPreKey")),
            json.array("preKeys").map { PublicPreKey.fromJson(it.requireObject()) },
        )
    }
}

/** A peer's bundle with at most one one-time prekey, as the server hands it out for starting a session. */
data class ClaimedBundle(
    val registrationId: Int,
    val identityKey: String,
    val signedPreKey: PublicSignedPreKey,
    val kyberPreKey: PublicSignedPreKey,
    val preKey: PublicPreKey? = null,
) {
    fun toJson(): JsonObject = jsonObject(
        "registrationId" to registrationId.json(),
        "identityKey" to identityKey.json(),
        "signedPreKey" to signedPreKey.toJson(),
        "kyberPreKey" to kyberPreKey.toJson(),
        "preKey" to preKey?.toJson(),
    )

    companion object {
        fun fromJson(json: JsonObject) = ClaimedBundle(
            json.int("registrationId"), json.string("identityKey"),
            PublicSignedPreKey.fromJson(json.obj("signedPreKey")), PublicSignedPreKey.fromJson(json.obj("kyberPreKey")),
            json["preKey"].asObject()?.let(PublicPreKey::fromJson),
        )
    }
}

data class CryptoDevice(
    val id: String,
    val userId: String,
    val deviceName: String,
    val identityKey: String,
    val registrationId: Int,
    val createdAt: String,
    val active: Boolean,
    val preKeyCount: Int? = null,
) {
    companion object {
        fun fromJson(json: JsonObject) = CryptoDevice(
            id = json.string("id"),
            userId = json.string("userId"),
            deviceName = json.stringOrNull("deviceName") ?: "",
            identityKey = json.string("identityKey"),
            registrationId = json.int("registrationId"),
            createdAt = json.stringOrNull("createdAt") ?: "",
            active = json.booleanOrNull("active") ?: false,
            preKeyCount = json.intOrNull("preKeyCount"),
        )
    }
}

/** One recipient device's ciphertext. [type] is libsignal's: 2 (a message of a running session) or 3 (a PreKey message). */
data class SignalEnvelope(val userId: String, val deviceId: String, val type: Int, val body: String) {
    fun toJson(): JsonObject = jsonObject("userId" to userId.json(), "deviceId" to deviceId.json(), "type" to type.json(), "body" to body.json())
}

data class EncryptedMessage(
    val senderDeviceId: String,
    val envelopes: List<SignalEnvelope>,
    val attachmentIds: List<String>? = null,
    /** "scheduled": encrypted in the sender's separate Signal session for «Отправить позже». */
    val lane: String? = null,
    val scheme: String = SCHEME,
) {
    fun toJson(): JsonObject = jsonObject(
        "scheme" to scheme.json(),
        "senderDeviceId" to senderDeviceId.json(),
        "envelopes" to JsonArray(envelopes.map { it.toJson() }),
        "attachmentIds" to attachmentIds?.let { ids -> JsonArray(ids.map { it.json() }) },
        "lane" to lane?.json(),
    )

    companion object {
        const val SCHEME = "signal-v1"

        /**
         * Reads the fields without judging them: null only when the shape cannot be read at all. Whether a
         * message is acceptable (its exact keys, sizes, identifiers) is decided by the encryption core.
         */
        fun fromJson(json: JsonValue?): EncryptedMessage? {
            val fields = json.asObject() ?: return null
            val envelopes = fields["envelopes"].asArray()?.map { item ->
                val envelope = item.asObject() ?: return null
                SignalEnvelope(
                    envelope["userId"].asString() ?: return null, envelope["deviceId"].asString() ?: return null,
                    envelope["type"].asInt() ?: return null, envelope["body"].asString() ?: return null,
                )
            } ?: return null
            return EncryptedMessage(
                senderDeviceId = fields["senderDeviceId"].asString() ?: return null,
                envelopes = envelopes,
                attachmentIds = fields["attachmentIds"].asArray()?.map { it.asString() ?: return null },
                lane = fields["lane"].asString(),
                scheme = fields["scheme"].asString() ?: return null,
            )
        }
    }
}
