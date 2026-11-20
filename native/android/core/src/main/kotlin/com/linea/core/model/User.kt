package com.linea.core.model

import com.linea.core.json.JsonObject
import com.linea.core.json.booleanOrNull
import com.linea.core.json.string
import com.linea.core.json.stringOrNull

data class User(
    val id: String,
    val username: String,
    val displayName: String,
    val bio: String,
    /** «MM-DD» or «YYYY-MM-DD»; null when not set. */
    val birthday: String? = null,
    /** Only colours birthday greetings: "male" or "female". */
    val gender: String? = null,
    val avatarColor: String,
    val avatarId: String? = null,
    val createdAt: String,
    val statusEmoji: String? = null,
    val statusEmojiExpiresAt: String? = null,
    val statusEmojiPermanent: Boolean? = null,
    /** Platina decoration, present only while the owner's Platina is active. */
    val avatarVideoId: String? = null,
    val avatarFrame: String? = null,
    val bannerId: String? = null,
    val bannerKind: String? = null,
    val bannerPreset: String? = null,
    /** "platina" while the owner's Platina is active. */
    val seal: String? = null,
    val profileEffect: String? = null,
    val nameplate: String? = null,
    val profilePattern: String? = null,
) {
    companion object {
        fun fromJson(json: JsonObject) = User(
            id = json.string("id"),
            username = json.string("username"),
            displayName = json.string("displayName"),
            bio = json.stringOrNull("bio") ?: "",
            birthday = json.stringOrNull("birthday"),
            gender = json.stringOrNull("gender"),
            avatarColor = json.stringOrNull("avatarColor") ?: "",
            avatarId = json.stringOrNull("avatarId"),
            createdAt = json.stringOrNull("createdAt") ?: "",
            statusEmoji = json.stringOrNull("statusEmoji"),
            statusEmojiExpiresAt = json.stringOrNull("statusEmojiExpiresAt"),
            statusEmojiPermanent = json.booleanOrNull("statusEmojiPermanent"),
            avatarVideoId = json.stringOrNull("avatarVideoId"),
            avatarFrame = json.stringOrNull("avatarFrame"),
            bannerId = json.stringOrNull("bannerId"),
            bannerKind = json.stringOrNull("bannerKind"),
            bannerPreset = json.stringOrNull("bannerPreset"),
            seal = json.stringOrNull("seal"),
            profileEffect = json.stringOrNull("profileEffect"),
            nameplate = json.stringOrNull("nameplate"),
            profilePattern = json.stringOrNull("profilePattern"),
        )
    }
}

/** The answer to a sign-in. [token] is a secret: it is never logged (see [toString]). */
class Session(val token: String, val user: User, val securitySetupRequired: Boolean = false) {
    override fun toString(): String = "Session(user=${user.id})"
}

data class DeviceSession(
    val id: String,
    val deviceName: String,
    val createdAt: String,
    val lastActiveAt: String,
    val expiresAt: String,
    val isCurrent: Boolean,
    val platform: String? = null,
    val deviceModel: String? = null,
    val osVersion: String? = null,
    val appVersion: String? = null,
    /** The address of the sign-in as the server saw it: text only, never geolocated. */
    val ip: String? = null,
    /** "hardware" or "software" when the session is bound to a device key, else null. */
    val deviceKey: String? = null,
) {
    companion object {
        fun fromJson(json: JsonObject) = DeviceSession(
            id = json.string("id"),
            deviceName = json.stringOrNull("deviceName") ?: "",
            createdAt = json.stringOrNull("createdAt") ?: "",
            lastActiveAt = json.stringOrNull("lastActiveAt") ?: "",
            expiresAt = json.stringOrNull("expiresAt") ?: "",
            isCurrent = json.booleanOrNull("isCurrent") ?: false,
            platform = json.stringOrNull("platform"),
            deviceModel = json.stringOrNull("deviceModel"),
            osVersion = json.stringOrNull("osVersion"),
            appVersion = json.stringOrNull("appVersion"),
            ip = json.stringOrNull("ip"),
            deviceKey = json.stringOrNull("deviceKey"),
        )
    }
}
