package com.linea.messenger.net

import com.linea.messenger.core.Core
import com.linea.messenger.auth.DeviceProof
import okhttp3.Call
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Why a request to the server did not give its answer. */
sealed class ServerError : Exception() {
  /** No answer came: there may be no internet. */
  class Network(override val words: String) : ServerError()
  /** The server answered no, in its own words. */
  class Refused(val refusal: String, val status: Int, val code: String?, val details: Map<String, Any?>) : ServerError() { override val words get() = refusal }
  class Timeout : ServerError() { override val words get() = "Сервер не ответил вовремя. Проверь подключение." }

  /** The words for the person. */
  abstract val words: String
}

/** One server, and the session on it when signed in. Every request is HTTPS with the system's certificate
 *  checks; no cookies, no cache, no redirects. */
class Server(base: String, @Volatile var token: String? = null) {
  val base: String = if (base.endsWith("/")) base.dropLast(1) else base

  private class Asked(val request: Request, val timeoutMs: Long)

  /** The session's device proof (see DeviceProof). Its own requests go out without waiting for a proof. */
  private val proof: DeviceProof by lazy {
    DeviceProof().also { made ->
      made.post = post@{ path, body ->
        val asked = try { request("POST", path, body) } catch (_: ServerError) { return@post null }
        try { call(asked).execute().use { Core.read(it.code, it.body?.string() ?: "") } } catch (_: IOException) { null }
      }
    }
  }
  /** The proof for the live line's first frame. */
  val currentProof: String? get() = if (token == null) null else proof.current

  private fun request(method: String, path: String, body: String?): Asked {
    val token = token
    val made = (if (base.startsWith("https://")) Core.prepare(method, path, jsonBody = body != null, token = token, proof = if (token == null) null else proof.current) else null)
      ?: throw ServerError.Network("Нет связи с сервером. Проверь интернет и адрес подключения.")
    val request = try {
      val builder = Request.Builder().url(base + path)
      for ((name, value) in made.headers) builder.header(name, value)
      // The content type is the core's header; the body itself adds none of its own.
      val sent = body?.toByteArray(Charsets.UTF_8)?.toRequestBody(null) ?: if (method == "GET" || method == "HEAD") null else ByteArray(0).toRequestBody(null)
      builder.method(method, sent).build()
    } catch (_: IllegalArgumentException) { throw ServerError.Network("Нет связи с сервером. Проверь интернет и адрес подключения.") }
    if (!request.isHttps) throw ServerError.Network("Нет связи с сервером. Проверь интернет и адрес подключения.")
    return Asked(request, made.timeoutMs)
  }

  private fun call(asked: Asked): Call = client.newBuilder().callTimeout(asked.timeoutMs, TimeUnit.MILLISECONDS).build().newCall(asked.request)

  private fun failure(error: IOException): ServerError =
    if (error is InterruptedIOException) ServerError.Timeout() else ServerError.Network("Нет связи с сервером. Проверь интернет и адрес подключения.")

  private fun answer(response: Response): Result<Any?> = response.use {
    val body = try { it.body?.string() ?: "" } catch (error: IOException) { return Result.failure(failure(error)) }
    val read = Core.read(it.code, body)
    if (read.containsKey("ok")) return Result.success(read["ok"])
    val refused = Core.map(read["refused"])
    if (refused != null) {
      return Result.failure(ServerError.Refused(refused["message"] as? String ?: "Не удалось выполнить запрос. Попробуй ещё раз.", it.code, refused["code"] as? String, refused))
    }
    Result.failure(ServerError.Network("Сервер недоступен."))
  }

  private fun once(method: String, path: String, body: String?): Result<Any?> {
    val asked = try { request(method, path, body) } catch (error: ServerError) { return Result.failure(error) }
    return try { answer(call(asked).execute()) } catch (error: IOException) { Result.failure(failure(error)) }
  }

  /** Whether the server refused a request for lack of a good device proof. */
  private fun wantsProof(result: Result<Any?>): Boolean = (result.exceptionOrNull() as? ServerError.Refused)?.let { it.status == 401 && it.code == "device_proof" } ?: false

  /** One request with everything around it, waiting for the answer on the calling thread (never the main one):
   *  the encryption service asks the server in the middle of its own work.
   *  A signed-in session is bound to this device's key: a request known to need the proof waits for a fresh
   *  one, and a request the server refuses for lack of it is repeated once with a new proof (the refused
   *  request did nothing, so repeating a write is safe). */
  fun sendAndWait(method: String, path: String, body: String? = null): Result<Any?> {
    val bound = token != null && !path.startsWith("/auth/device/")
    if (!bound) return once(method, path, body)
    val proof = proof
    val first = proof.due && !proof.known
    if (proof.due && !first) proof.ensure(force = false)
    val seen = proof.generation
    // Not known yet whether this session needs a proof: the request goes at once, the exchange starts beside it.
    if (first) work.execute { proof.ensure(force = false) }
    val result = once(method, path, body)
    if (!wantsProof(result)) return result
    return when (proof.ensure(force = true, seen = seen)) {
      DeviceProof.Outcome.LOST -> Result.failure(ServerError.Refused("Войдите в аккаунт заново.", 401, null, emptyMap()))
      DeviceProof.Outcome.FAILED -> Result.failure(ServerError.Network("Не удалось подтвердить устройство. Проверь подключение."))
      DeviceProof.Outcome.OK -> {
        val again = once(method, path, body)
        // Still refused with a fresh proof: not a reason to sign the account out — say it could not be done.
        if (wantsProof(again)) Result.failure(ServerError.Network("Не удалось подтвердить устройство. Попробуй ещё раз.")) else again
      }
    }
  }

  /** Sends a request; the answer's JSON body comes back on a background thread. A failure is a `ServerError`. */
  fun send(method: String, path: String, body: String? = null, done: (Result<Any?>) -> Unit) {
    work.execute { done(sendAndWait(method, path, body)) }
  }

  /** A server operation by its name (the table is in the core): `op("chats", emptyList())`. */
  fun op(name: String, args: List<Any?>, done: (Result<Any?>) -> Unit) {
    val call = Core.call(name, args) ?: return done(Result.failure(ServerError.Network("Не удалось выполнить запрос. Попробуй ещё раз.")))
    send(call.method, call.path, call.body, done)
  }

  fun opAndWait(name: String, args: List<Any?>): Result<Any?> {
    val call = Core.call(name, args) ?: return Result.failure(ServerError.Network("Не удалось выполнить запрос. Попробуй ещё раз."))
    return sendAndWait(call.method, call.path, call.body)
  }

  companion object {
    /** One client for the whole app: TLS only (never plain HTTP), certificates checked by the system, no cookie
     *  jar and no cache (neither is ever set), and a redirect is never followed — the server does not send
     *  them, and following one would carry the session elsewhere. The client itself sends a request once: the
     *  only repeat is the one after a refused device proof (`sendAndWait`). */
    val client: OkHttpClient = OkHttpClient.Builder()
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
      .followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()

    /** Where the requests of `send` wait for their answers, each on a thread of its own. */
    private val work = Executors.newCachedThreadPool { run -> Thread(run, "invizent.server").apply { isDaemon = true } }

    /** The failure of a result as the kind this file gives; anything else reads as «no connection». */
    fun error(result: Result<*>): ServerError = result.exceptionOrNull() as? ServerError ?: ServerError.Network("Нет связи с сервером.")
  }
}
