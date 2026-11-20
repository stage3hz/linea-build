package com.linea.core.api

import com.linea.core.device.RefusedRequest
import com.linea.core.json.JsonNumber
import com.linea.core.json.JsonObject
import com.linea.core.json.asString

/** An error the server returned. */
class ApiError(message: String, override val status: Int, details: JsonObject = JsonObject.EMPTY) : Exception(message), RefusedRequest {
    override val code: String? = details["code"].asString()
    val attemptsRemaining: Int? = wholeIn(details, "attemptsRemaining", 0, 3)?.toInt()

    /** Wrong sign-ins left before the 5-minute lock. */
    val attemptsLeft: Int? = wholeIn(details, "attemptsLeft", 0, 5)?.toInt()
    val retryAfterSeconds: Double? = (details["retryAfterSeconds"] as? JsonNumber)?.value?.takeIf { it.isFinite() && it >= 0 }
    val readyAt: String? = details["readyAt"].asString()
    val serverTime: String? = details["serverTime"].asString()
    val expiresAt: String? = details["expiresAt"].asString()

    /** Chunked uploads: how many bytes the server already has, to resume from there. */
    val received: Long? = wholeIn(details, "received", 0, Long.MAX_VALUE)

    /** The server no longer accepts this build (426): the app must be updated. */
    val updateRequired: Boolean get() = status == 426

    private companion object {
        fun wholeIn(details: JsonObject, name: String, min: Long, max: Long): Long? =
            (details[name] as? JsonNumber)?.safeLong?.takeIf { it in min..max }
    }
}

/** No answer at all (as opposed to an error the server returned). */
open class NetworkError(message: String, val notDelivered: Boolean = false) : Exception(message)

/**
 * No answer in time. A kind of [NetworkError] on purpose: a silent server (a typical block) still fails over to the
 * next server; only the text tells it apart from «no connection».
 */
class RequestTimeoutError(message: String) : NetworkError(message)
