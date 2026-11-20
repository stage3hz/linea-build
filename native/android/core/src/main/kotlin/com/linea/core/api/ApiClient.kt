package com.linea.core.api

import com.linea.core.device.DeviceProof
import com.linea.core.device.DeviceProofException
import com.linea.core.json.JsonException
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonValue
import com.linea.core.json.asObject
import com.linea.core.json.asString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Requests to the server for one account (or none, before sign-in): headers, the device proof of a bound session,
 * fail-over to the next server, and the server's errors.
 *
 * @param base the account's realm (fixed: keys and history on the device are tied to it).
 */
open class ApiClient(protected val runtime: ApiRuntime, val base: String, val token: String? = null) {
    private val deviceProof: DeviceProof?
        get() {
            val token = token ?: return null
            return runtime.proofFor(token) {
                DeviceProof(runtime.deviceKey, { path, body -> requestOnce(path, "POST", body, endpoint) }, runtime.clock, runtime.scope)
            }
        }

    /**
     * The headers of a signed-in request made outside [request] (uploads, downloads, players): the token and, for
     * a session bound to this device, its current proof. This is the one place that builds them.
     */
    val authHeaders: Map<String, String>
        get() {
            val token = token ?: return emptyMap()
            val proof = deviceProof?.current
            return if (proof != null) mapOf("Authorization" to "Bearer $token", DeviceProof.HEADER to proof) else mapOf("Authorization" to "Bearer $token")
        }

    /** The proof for the socket's `auth` frame. */
    val proof: String? get() = deviceProof?.current

    /**
     * Makes sure the session's device proof is fresh before something that cannot retry by itself (the socket, an
     * upload). Never throws for a passing failure — the server then asks for the proof and the request path
     * retries; a session bound to a key this device no longer has ends as an expired one (401).
     */
    suspend fun ensureProof(force: Boolean = false, seen: Int? = null) {
        val held = deviceProof ?: return
        if (!force && !held.due) return
        try {
            held.refresh(force, seen)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (error is DeviceProofException && error.reason == DeviceProofException.Reason.LOST) throw ApiError("Войдите в аккаунт заново.", 401)
            if (!force) return
            if (error is ApiError && error.status == 401) throw error
            throw NetworkError(if (error is DeviceProofException) error.message.orEmpty() else "Не удалось подтвердить устройство. Проверь подключение.")
        }
    }

    /** Where requests go now: for the main realm, the fastest live server from the pool. */
    val endpoint: String get() = if (pooled) runtime.endpoints.currentEndpoint() else base

    private val pooled: Boolean get() = base.trimEnd('/') == runtime.config.serverUrl

    /** Sends a request and returns the parsed answer (an empty object when the body is empty or not JSON). */
    suspend fun request(path: String, method: String = "GET", body: JsonValue? = null): JsonValue {
        val bound = token != null && !path.startsWith("/auth/device/")
        val held = if (bound) deviceProof else null
        // A session known to need a proof waits for a fresh one. While that is not known yet (the first requests
        // of a run), the request goes at once and the exchange starts beside it: an unbound session, or an older
        // server, is not held back at all.
        val first = held != null && held.due && !held.known
        if (held != null && held.due && !first) ensureProof(false)
        val seen = held?.generation
        if (first) runtime.scope.launch { try { held!!.refresh() } catch (_: Exception) { /* the request path asks again */ } }
        try {
            return send(path, method, body)
        } catch (error: ApiError) {
            // The server wants the device proof (ours ran out, or the session was bound a moment ago): get one and
            // repeat. Nothing was done by the refused request, so repeating a write is safe.
            if (!bound || error.status != 401 || error.code != "device_proof") throw error
            ensureProof(true, seen)
            try {
                return send(path, method, body)
            } catch (again: ApiError) {
                // Still refused with a fresh proof: not a reason to sign the account out — say it could not be done.
                if (again.status == 401 && again.code == "device_proof") throw NetworkError("Не удалось подтвердить устройство. Попробуй ещё раз.")
                throw again
            }
        }
    }

    private suspend fun send(path: String, method: String, body: JsonValue?): JsonValue {
        val target = endpoint
        try {
            return requestOnce(path, method, body, target)
        } catch (error: NetworkError) {
            if (!pooled) throw error
            runtime.endpoints.reportFailure(target)
            // Only reads are repeated on the next server automatically; writes have their own retries (messages
            // are idempotent by clientId) so nothing is ever done twice.
            val next = endpoint
            if ((method == "GET" || method == "HEAD" || error.notDelivered) && next != target) return requestOnce(path, method, body, next)
            throw error
        }
    }

    private suspend fun requestOnce(path: String, method: String, body: JsonValue?, target: String): JsonValue {
        val timeoutMs = RequestTimeouts.forRequest(path, method, runtime.quality.tier, runtime.config.testBuild)
        val started = runtime.clock()
        val headers = LinkedHashMap<String, String>()
        headers[com.linea.core.config.ClientHeader.NAME] = runtime.clientHeader
        headers.putAll(runtime.attest.headers(method, path, started))
        if (body != null) headers["Content-Type"] = "application/json"
        headers.putAll(authHeaders)
        val request = HttpRequest(method, target + path, headers, body?.stringify())
        val response = try {
            // Our own limit as well as the transport's: an answer that trickles in must not hold a request for ever.
            withTimeoutOrNull(timeoutMs) { runtime.transport.execute(request, timeoutMs) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: java.net.SocketTimeoutException) {
            throw RequestTimeoutError(TIMEOUT_TEXT)
        } catch (_: Exception) {
            throw NetworkError(NO_CONNECTION_TEXT)
        } ?: throw RequestTimeoutError(TIMEOUT_TEXT)

        // A redirect is never followed: an answer that sends the app elsewhere is no answer.
        if (response.status in 300..399) throw NetworkError(NO_CONNECTION_TEXT)
        val data = try { if (response.body.isEmpty()) JsonObject.EMPTY else JsonValue.parse(response.body) } catch (_: JsonException) { JsonObject.EMPTY }
        if (response.status < 500) {
            runtime.endpoints.markServerOk()
            runtime.quality.report(runtime.clock() - started, response.body.length)
        }
        if (response.status == 426) runtime.onUpdateRequired()
        // 502/503/504 come from the proxy in front of a server that is down: the request never reached the
        // server itself, so it is safe to send it to the next one.
        if (response.status == 502 || response.status == 503 || response.status == 504) throw NetworkError("Сервер недоступен.", notDelivered = true)
        if (response.status !in 200..299) {
            val details = data.asObject() ?: JsonObject.EMPTY
            throw ApiError(details["error"].asString() ?: "Не удалось выполнить запрос. Попробуй ещё раз.", response.status, details)
        }
        return data
    }

    private companion object {
        const val TIMEOUT_TEXT = "Сервер не ответил вовремя. Проверь подключение."
        const val NO_CONNECTION_TEXT = "Нет связи с сервером. Проверь интернет и адрес подключения."
    }
}
