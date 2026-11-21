package com.linea.messenger.net

import com.linea.messenger.core.Core
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
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

  private fun request(method: String, path: String, body: String?): Asked {
    val made = (if (base.startsWith("https://")) Core.prepare(method, path, jsonBody = body != null, token = token) else null)
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

  /** Sends a request; the answer's JSON body comes back on a background thread. A failure is a `ServerError`. */
  fun send(method: String, path: String, body: String? = null, done: (Result<Any?>) -> Unit) {
    val asked = try { request(method, path, body) } catch (error: ServerError) { return done(Result.failure(error)) }
    call(asked).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) = done(Result.failure(failure(e)))
      override fun onResponse(call: Call, response: Response) = done(answer(response))
    })
  }

  /** The same, waiting for the answer on the calling thread (never the main one): the encryption service
   *  asks the server in the middle of its own work. */
  fun sendAndWait(method: String, path: String, body: String? = null): Result<Any?> {
    val asked = try { request(method, path, body) } catch (error: ServerError) { return Result.failure(error) }
    return try { answer(call(asked).execute()) } catch (error: IOException) { Result.failure(failure(error)) }
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
     *  them, and following one would carry the session elsewhere. A request is sent once: nothing is repeated
     *  behind the app's back. */
    val client: OkHttpClient = OkHttpClient.Builder()
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
      .followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()

    /** The failure of a result as the kind this file gives; anything else reads as «no connection». */
    fun error(result: Result<*>): ServerError = result.exceptionOrNull() as? ServerError ?: ServerError.Network("Нет связи с сервером.")
  }
}
