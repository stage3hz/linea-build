package com.linea.core.device

import com.linea.core.json.JsonBool
import com.linea.core.json.JsonNumber
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonValue
import com.linea.core.json.asObject
import com.linea.core.json.asString
import com.linea.core.json.json
import com.linea.core.json.jsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A refusal by the server, as the proof exchange needs to see it (the API's error implements this). */
interface RefusedRequest {
    val status: Int
    val code: String?
}

/** POST with the session token. Throws an exception that is a [RefusedRequest] when the server says no. */
fun interface ProofPost {
    suspend fun post(path: String, body: JsonValue?): JsonValue
}

/**
 * `LOST`: the session is bound to a key this device does not have — it cannot be used here any more.
 * `UNAVAILABLE`: the key could not sign right now: try again later.
 */
class DeviceProofException(val reason: Reason) : Exception(
    if (reason == Reason.LOST) "Сеанс привязан к другому устройству. Войди заново." else "Не удалось подтвердить устройство. Попробуй ещё раз.",
) {
    enum class Reason { LOST, UNAVAILABLE }
}

/**
 * A session bound to this device's key (server: devicebind.js).
 *
 * The session token on the disk is not enough for a bound session: every request also carries a «proof» — a random
 * value the server hands out for ten minutes in exchange for a signature by the device's key. The proof lives in
 * memory only, never on the disk: a copied token, or the whole folder of the app, signs in nowhere else.
 *
 *   challenge → (first time) bind the session to the key / (afterwards) sign the challenge → proof.
 *
 * An older server (no such routes) or a device without a key: nothing happens, the session works as before.
 *
 * @param scope runs the exchange, so that a caller who gives up does not take it away from the others waiting.
 * @param selfRenew renew the proof by itself shortly before it runs out, while the app runs.
 */
class DeviceProof(
    private val key: () -> DeviceKey?,
    private val post: ProofPost,
    private val now: () -> Long,
    private val scope: CoroutineScope,
    private val selfRenew: Boolean = true,
) {
    private val lock = Any()
    private var proof: String? = null
    private var until = 0L
    private var busy: CompletableDeferred<Boolean>? = null

    /** Nothing to do for this session in this run: the server has no binding, or there is no key to bind with. */
    private var off = false
    private var failedAt = -PROOF_RETRY_MS
    private var timer: Job? = null
    private var issued = 0

    /** The proof to send with a request, or null. */
    val current: String? get() = synchronized(lock) { proof?.takeIf { until > now() } }

    /** Grows with every proof received: lets a refused request tell whether a newer proof has arrived since it left. */
    val generation: Int get() = synchronized(lock) { issued }

    /** Whether a proof was ever held in this run: only then is the session known to need one. */
    val known: Boolean get() = synchronized(lock) { until > 0 }

    /** Whether a request should first wait for [refresh]. */
    val due: Boolean get() = synchronized(lock) { !off && until - now() < PROOF_MARGIN_MS && now() - failedAt >= PROOF_RETRY_MS }

    /**
     * Gets a proof (binding the session to the key first, if it has none). Returns true when a proof is held, false
     * when this session does not use one. Throws [DeviceProofException], or the transport's own error.
     *
     * @param force the server has just refused the proof we hold.
     * @param seen the [generation] when the refused request was sent — if a newer proof has arrived since (many
     *   requests were refused together), that one is used.
     */
    suspend fun refresh(force: Boolean = false, seen: Int? = null): Boolean {
        val run: CompletableDeferred<Boolean>
        synchronized(lock) {
            val running = busy
            if (running != null) {
                run = running
            } else {
                if (off) return false
                val held = proof != null && until > now()
                if (force && seen != null && seen != issued && held) return true
                if (!force && held && until - now() >= PROOF_MARGIN_MS) return true
                run = CompletableDeferred()
                busy = run
                scope.launch { runExchange(run) }
            }
        }
        return run.await()
    }

    private suspend fun runExchange(run: CompletableDeferred<Boolean>) {
        val outcome = try {
            Result.success(exchange(again = true))
        } catch (error: Throwable) {
            synchronized(lock) { failedAt = now() }
            Result.failure(error)
        }
        synchronized(lock) { if (busy === run) busy = null }
        outcome.fold(run::complete, run::completeExceptionally)
    }

    private suspend fun exchange(again: Boolean): Boolean {
        val key = key()
        val challenge = try {
            post.post("/auth/device/challenge", null).asObject()
        } catch (error: Exception) {
            // A server from before device binding: the session stays as it is.
            if (error is RefusedRequest && error.status == 404) return switchOff()
            throw error
        }
        val nonce = challenge?.get("challenge").asString()
        val sessionId = challenge?.get("sessionId").asString()
        if (nonce == null || sessionId == null) throw DeviceProofException(DeviceProofException.Reason.UNAVAILABLE)

        if (!truthy(challenge?.get("bound"))) {
            // Not bound yet. Without a key it stays unbound.
            if (key == null) return switchOff()
            val own: DeviceKeyInfo
            val signature: String
            try {
                own = key.ensure()
                signature = key.sign("$BIND_PURPOSE\n$sessionId\n$nonce")
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return switchOff() // no working key on this device: as before, by the token
            }
            return try {
                take(post.post("/auth/device/bind", jsonObject("publicKey" to own.publicKey.json(), "kind" to own.kind.wire.json(), "signature" to signature.json())))
            } catch (error: Exception) {
                val refusal = error as? RefusedRequest
                // Bound a moment ago by another request of this app: prove it instead.
                if (again && (refusal?.code == "device_bound" || refusal?.code == "device_challenge")) return exchange(again = false)
                if (refusal?.status == 400 || refusal?.status == 403) return switchOff()
                throw error
            }
        }

        if (key == null) throw DeviceProofException(DeviceProofException.Reason.LOST)
        val signature = try {
            key.sign("$PROOF_PURPOSE\n$sessionId\n$nonce")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val changed = error is DeviceKeyChangedException || KEY_CHANGED.containsMatchIn(error.message.orEmpty())
            throw DeviceProofException(if (changed) DeviceProofException.Reason.LOST else DeviceProofException.Reason.UNAVAILABLE)
        }
        return try {
            take(post.post("/auth/device/proof", jsonObject("signature" to signature.json())))
        } catch (error: Exception) {
            val refusal = error as? RefusedRequest
            if (refusal?.code == "device_signature") throw DeviceProofException(DeviceProofException.Reason.LOST)
            if (again && refusal?.code == "device_challenge") return exchange(again = false)
            throw error
        }
    }

    private fun switchOff(): Boolean {
        synchronized(lock) { off = true }
        return false
    }

    private fun take(answer: JsonValue): Boolean {
        val fields = answer.asObject()
        val value = fields?.get("proof").asString()
        val expiresIn = (fields?.get("expiresIn") as? JsonNumber)?.value
        if (value == null || expiresIn == null || !(expiresIn > 0)) throw DeviceProofException(DeviceProofException.Reason.UNAVAILABLE)
        val lifetimeMs = (expiresIn * 1000).toLong()
        synchronized(lock) {
            proof = value
            issued++
            until = now() + lifetimeMs
            if (selfRenew) {
                timer?.cancel()
                // Renewed by itself while the app runs, so a long upload or an open socket never meets an expired proof.
                timer = scope.launch {
                    delay(maxOf(30_000L, lifetimeMs - PROOF_MARGIN_MS - 30_000L))
                    try { refresh() } catch (error: CancellationException) { throw error } catch (_: Exception) { /* the next request tries again */ }
                }
            }
        }
        return true
    }

    /** JavaScript truthiness of the `bound` field, which the reference tests with `!challenge.bound`. */
    private fun truthy(value: JsonValue?): Boolean = when (value) {
        null, com.linea.core.json.JsonNull -> false
        is JsonBool -> value.value
        is JsonNumber -> value.value != 0.0 && !value.value.isNaN()
        is com.linea.core.json.JsonString -> value.value.isNotEmpty()
        is JsonObject, is com.linea.core.json.JsonArray -> true
    }

    companion object {
        /** Renew this long before the proof runs out. */
        const val PROOF_MARGIN_MS = 90_000L

        /** After a failed attempt the next request does not try again sooner than this. */
        const val PROOF_RETRY_MS = 5_000L

        const val HEADER = "X-Linea-Proof"
        private const val BIND_PURPOSE = "invizent-device-bind-v1"
        private const val PROOF_PURPOSE = "invizent-device-proof-v1"
        private val KEY_CHANGED = Regex("key changed", RegexOption.IGNORE_CASE)
    }
}
