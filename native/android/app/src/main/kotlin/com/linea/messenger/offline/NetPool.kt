package com.linea.messenger.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import com.linea.core.config.ServerConfig
import com.linea.core.network.NetworkQuality
import com.linea.core.network.NetworkTier
import com.linea.core.servers.PoolNetwork
import com.linea.core.servers.PoolStore
import com.linea.core.servers.ServerPool
import com.linea.core.servers.SignedServerList
import com.linea.messenger.net.Server
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

/** Which server address the app talks to right now, how fast the connection is, and when the phone's network came
 *  back (iOS: Sources/Offline/ServerPool.swift). Ported from the reference: mobile/src/servers/pool.ts (here the
 *  shared Kotlin port `com.linea.core.servers.ServerPool` with its rules), network/quality.ts
 *  (`com.linea.core.network.NetworkQuality`) and network/netChange.ts.
 *
 *  The account lives at a fixed «realm» (Account.server): keys and history on the device are tied to it, never to
 *  the address in use. For the real server the requests go to the fastest live address of: the realm itself, the
 *  address earlier builds used, and — only when no direct address answers (a VPN that cannot reach the server) —
 *  the reserve entrance through Cloudflare. Every address is HTTPS with the system's certificate checks; a local
 *  test server is never pooled. */
object NetPool {
  /** The measured speed of the connection; its tier stretches the time limits (the core's `request_timeout`). */
  val quality = NetworkQuality()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  @Volatile private var pool: ServerPool? = null
  private var started = false
  private var lastNetwork: String? = null
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private val main by lazy { Handler(Looper.getMainLooper()) }

  /** "slow" / "medium" / "fast", as the core's `invizent_http_prepare` reads it. */
  val tier: String get() = when (quality.tier) { NetworkTier.SLOW -> "slow"; NetworkTier.MEDIUM -> "medium"; NetworkTier.FAST -> "fast" }

  /** Only the real server is pooled; a test server is used as it is. */
  fun pooled(base: String): Boolean = base == ServerConfig.PRODUCTION_SERVER_URL

  /** Where the requests of an account at `base` go now (the realm until the first measurement). */
  fun endpoint(base: String): String = if (pooled(base)) pool?.currentEndpoint() ?: base else base

  /** A request to `endpoint` got no answer: it is skipped at once and everything is measured again. */
  fun reportFailure(endpoint: String) { pool?.reportFailure(endpoint) }

  /** Any answer below 500 from a server of ours. */
  fun markServerOk() { pool?.markServerOk() }

  /** Called on the main thread when the phone got its network back or moved to another one. */
  fun onNetworkBack(listener: () -> Unit): () -> Unit { listeners.add(listener); return { listeners.remove(listener) } }

  /** Restores the address the last run used, measures every address and keeps measuring; watches the network. Main thread. */
  fun start(context: Context, base: String) {
    if (started) return
    started = true
    val app = context.applicationContext
    watchNetwork(app)
    if (!pooled(base)) return
    val prefs = app.getSharedPreferences("invizent.servers", Context.MODE_PRIVATE)
    val made = ServerPool(
      config = ServerConfig.PRODUCTION,
      listKeys = emptyList(), // the reference's SERVER_LIST_KEYS is empty: only the built-in addresses
      network = object : PoolNetwork {
        override suspend fun healthy(url: String, timeoutMs: Long): Boolean = withContext(Dispatchers.IO) {
          try {
            val client = Server.client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
            client.newCall(Request.Builder().url("$url/health").get().build()).execute().use { it.isSuccessful }
          } catch (_: Exception) { false }
        }
        override suspend fun signedList(from: String): SignedServerList? = null
      },
      store = object : PoolStore {
        override suspend fun load(): String? = prefs.getString("state", null)
        override suspend fun save(value: String) { prefs.edit().putString("state", value).apply() }
      },
      tier = { quality.tier },
      scope = scope,
    )
    pool = made
    scope.launch { made.start() }
  }

  /** Going offline is not a change to act on; coming back, or a different network, is (the reference's netChange.ts). */
  private fun watchNetwork(context: Context) {
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
    try {
      manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { changed(network.toString()) }
        override fun onLost(network: Network) { changed("offline") }
      })
    } catch (_: Exception) { /* no network events: the line keeps its own pauses */ }
  }

  @Synchronized private fun changed(key: String) {
    val previous = lastNetwork
    lastNetwork = key
    if (previous == null || key == previous || key == "offline") return
    pool?.let { made -> scope.launch { made.measure() } }
    main.post { for (listener in listeners) listener() }
  }
}
