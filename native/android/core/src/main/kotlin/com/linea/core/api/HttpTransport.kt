package com.linea.core.api

class HttpRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String?) {
    /** Headers carry the session token and the body may carry a password: only the method and address are printed. */
    override fun toString(): String = "HttpRequest($method ${url.substringBefore('?')})"
}

class HttpResponse(val status: Int, val body: String)

/**
 * Sends one request and returns whatever the server answered, whatever its status.
 *
 * An implementation must verify TLS certificates as the platform does, must not follow redirects, must not keep
 * cookies or a cache, and must not log headers or bodies. When no answer was received it throws
 * [java.io.IOException]; it honours coroutine cancellation.
 */
fun interface HttpTransport {
    suspend fun execute(request: HttpRequest, timeoutMs: Long): HttpResponse
}
