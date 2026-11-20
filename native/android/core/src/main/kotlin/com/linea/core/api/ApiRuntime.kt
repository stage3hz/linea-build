package com.linea.core.api

import com.linea.core.attest.Attest
import com.linea.core.config.ClientHeader
import com.linea.core.config.ServerConfig
import com.linea.core.device.DeviceInfo
import com.linea.core.device.DeviceKey
import com.linea.core.device.DeviceProof
import com.linea.core.network.NetworkQuality
import kotlinx.coroutines.CoroutineScope
import java.util.concurrent.ConcurrentHashMap

/** Which address requests to the main realm go to, and what happened to them (the server pool). */
interface EndpointSource {
    fun currentEndpoint(): String

    /** A request to [endpoint] failed at the network level. */
    fun reportFailure(endpoint: String)

    /** Any HTTP answer from any server (tells «no internet» from a short drop). */
    fun markServerOk()
}

/** Everything the API clients of one running app share. */
class ApiRuntime(
    val config: ServerConfig,
    val transport: HttpTransport,
    val endpoints: EndpointSource,
    val quality: NetworkQuality,
    val attest: Attest,
    val device: DeviceInfo,
    /** The key sessions are bound to, or null on a device that has none. */
    val deviceKey: () -> DeviceKey?,
    /** Runs what must outlive a single request: the proof exchange and its renewal. */
    val scope: CoroutineScope,
    val clock: () -> Long = System::currentTimeMillis,
    val clientHeader: String = ClientHeader.value(),
    /** The server refused this build as too old (426). */
    val onUpdateRequired: () -> Unit = {},
) {
    /** One proof exchange per session token, shared by every client made for it. In memory only. */
    private val proofs = ConcurrentHashMap<String, DeviceProof>()

    internal fun proofFor(token: String, create: () -> DeviceProof): DeviceProof = proofs.computeIfAbsent(token) { create() }

    /** After sign-out: the token is gone, so is its proof. */
    fun forgetProof(token: String) { proofs.remove(token) }
}
