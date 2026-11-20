package com.linea.core.servers

import com.linea.core.api.EndpointSource
import com.linea.core.config.ServerConfig
import com.linea.core.json.JsonNull
import com.linea.core.json.JsonValue
import com.linea.core.json.asObject
import com.linea.core.json.asString
import com.linea.core.json.json
import com.linea.core.json.jsonObject
import com.linea.core.network.NetworkTier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.CopyOnWriteArraySet

/** The two unauthenticated requests the pool makes. Neither carries the session token. */
interface PoolNetwork {
    /** GET `<url>/health`: true only for a 2xx answer within [timeoutMs]; false for anything else. */
    suspend fun healthy(url: String, timeoutMs: Long): Boolean

    /** GET `<from>/servers`: the signed list as received, or null. */
    suspend fun signedList(from: String): SignedServerList?
}

/** Where the pool remembers the signed list and the server in use between runs. */
interface PoolStore {
    suspend fun load(): String?
    suspend fun save(value: String)
}

data class ServerStatus(val current: String, val rtt: Map<String, Long?>, val listVersion: Long?)

/**
 * Which server the app talks to right now. The account itself lives at a fixed «realm» — keys and history on the
 * device are tied to it, never to the address in use. Servers: the built-in ones plus a list signed by the owner.
 * The fastest live one is used; a failed one is skipped at once; everything is re-measured every few minutes and
 * after a failure.
 */
class ServerPool(
    private val config: ServerConfig,
    private val listKeys: List<String>,
    private val network: PoolNetwork,
    private val store: PoolStore,
    private val tier: () -> NetworkTier,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val verifier: ListSignatureVerifier = Ed25519Verifier,
) : EndpointSource {
    private data class State(
        val list: ServerList? = null,
        val signed: SignedServerList? = null,
        val current: String? = null,
        val rtt: Map<String, Long?> = emptyMap(),
        val down: Map<String, Long> = emptyMap(),
    )

    private val lock = Any()
    private var state = State()
    private var started = false
    private var probing: CompletableDeferred<Unit>? = null
    private var timer: Job? = null
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    @Volatile private var lastOk = 0L

    fun builtinServers(): List<String> = (listOf(config.serverUrl) + config.legacyServerUrls).mapNotNull(ServerListRules::normalizeServer)

    private fun edgeServers(): List<String> = config.edgeServerUrls.mapNotNull(ServerListRules::normalizeServer)

    fun candidates(): List<String> = synchronized(lock) {
        (builtinServers() + state.list?.servers.orEmpty().map { it.url } + edgeServers()).distinct()
    }

    /** The address requests go to now (the realm until the first measurement). */
    override fun currentEndpoint(): String = synchronized(lock) { state.current } ?: builtinServers().firstOrNull() ?: config.serverUrl

    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    override fun markServerOk() { lastOk = clock() }

    fun lastServerOkAt(): Long = lastOk

    fun status(): ServerStatus = synchronized(lock) { ServerStatus(currentEndpoint(), state.rtt.toMap(), state.list?.version) }

    private fun emit() = listeners.forEach { it() }

    /** Probes wait longer on a slow link (EDGE: one TLS handshake alone takes about a second). */
    private fun probeTimeout(): Long = when (tier()) { NetworkTier.SLOW -> 9000L; NetworkTier.MEDIUM -> 5000L; NetworkTier.FAST -> 3000L }

    private suspend fun probe(url: String): Long? {
        var best: Long? = null
        repeat(2) {
            val start = clock()
            val ok = try { network.healthy(url, probeTimeout()) } catch (error: CancellationException) { throw error } catch (_: Exception) { false }
            if (ok) {
                val ms = clock() - start
                best = best?.let { minOf(it, ms) } ?: ms
            }
        }
        return best
    }

    private suspend fun refreshList(from: String): Boolean {
        if (listKeys.isEmpty()) return false
        val signed = try { network.signedList(from) } catch (error: CancellationException) { throw error } catch (_: Exception) { null } ?: return false
        synchronized(lock) {
            val known = state.list
            val list = ServerListRules.verifyServerList(signed, listKeys, verifier, known?.version ?: 0) ?: return false
            if (known != null && list.version <= known.version) return false
            state = state.copy(list = list, signed = signed)
            return true
        }
    }

    /** Measures every candidate and switches if needed. Safe to call often (one run at a time). */
    suspend fun measure() {
        val run = synchronized(lock) {
            probing ?: CompletableDeferred<Unit>().also { fresh ->
                probing = fresh
                scope.launch {
                    var again = false
                    try {
                        again = measureOnce()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        // Keep what we have; the next measurement tries again.
                    } finally {
                        synchronized(lock) { probing = null }
                        fresh.complete(Unit)
                    }
                    // A new list brought new servers: measure them right away rather than in five minutes.
                    if (again) measure()
                }
            }
        }
        run.await()
    }

    private suspend fun measureOnce(): Boolean {
        val urls = candidates()
        val now = clock()
        val down = synchronized(lock) { state.down }
        val results = coroutineScope {
            urls.map { url -> async { url to if ((down[url] ?: 0L) != 0L && now - down.getValue(url) < DOWN_MS) null else probe(url) } }.awaitAll()
        }
        val rtt = LinkedHashMap<String, Long?>().apply { putAll(results) }
        // The reserve entrance is chosen only when no direct server answers at all.
        val edges = edgeServers()
        val direct = rtt.filterKeys { it !in edges }
        val reserve = rtt.filterKeys { it in edges }
        val current = synchronized(lock) {
            val previous = state.current
            val keep = previous?.takeIf { !(rtt.containsKey(it) && rtt[it] == null) }
            val chosen = ServerListRules.chooseServer(keep?.takeIf { it !in edges }, direct)
                ?: (if (direct.values.any { it != null }) null else ServerListRules.chooseServer(keep?.takeIf { it in edges }, reserve))
                ?: previous
            state = state.copy(rtt = rtt, current = chosen)
            chosen
        }
        val fresh = if (current != null) refreshList(current) else false
        emit()
        val saved = synchronized(lock) {
            jsonObject(
                "signed" to (state.signed?.let { jsonObject("payload" to it.payload.json(), "sig" to it.sig.json()) } ?: JsonNull),
                "current" to (state.current?.json() ?: JsonNull),
            ).stringify()
        }
        try { store.save(saved) } catch (error: CancellationException) { throw error } catch (_: Exception) { /* measured again next run */ }
        return fresh
    }

    /** A request to [endpoint] failed at the network level: skip it right away and re-measure. */
    override fun reportFailure(endpoint: String) {
        val url = ServerListRules.normalizeServer(endpoint) ?: return
        val all = candidates()
        val switched = synchronized(lock) {
            val now = clock()
            state = state.copy(down = state.down + (url to now), rtt = state.rtt + (url to null))
            if (state.current != url) return@synchronized false
            val next = ServerListRules.fallbackServer(url, all, state.rtt, state.down, now, DOWN_MS)
            state = state.copy(current = next ?: state.current)
            true
        }
        if (switched) emit()
        scope.launch { measure() }
    }

    /** Restores what the last run knew, measures, and keeps measuring every few minutes. */
    suspend fun start() {
        synchronized(lock) { if (started) return; started = true }
        try {
            val saved = store.load()?.let(JsonValue::parse).asObject()
            // The cached list is trusted again only after its signature is re-checked.
            val signed = saved?.get("signed").asObject()?.let { fields ->
                val payload = fields["payload"].asString()
                val sig = fields["sig"].asString()
                if (payload != null && sig != null) SignedServerList(payload, sig) else null
            }
            val list = ServerListRules.verifyServerList(signed, listKeys, verifier, 0)
            if (list != null) synchronized(lock) { state = state.copy(list = list, signed = signed) }
            val current = ServerListRules.normalizeServer(saved?.get("current").asString())
            if (current != null && current in candidates()) synchronized(lock) { state = state.copy(current = current) }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // First start, or nothing readable was saved.
        }
        measure()
        synchronized(lock) {
            timer = scope.launch {
                while (isActive) {
                    delay(REPROBE_MS)
                    measure()
                }
            }
        }
    }

    fun stop() {
        synchronized(lock) { timer?.cancel(); timer = null; started = false }
    }

    companion object {
        const val REPROBE_MS = 5 * 60_000L
        const val DOWN_MS = 60_000L
    }
}
