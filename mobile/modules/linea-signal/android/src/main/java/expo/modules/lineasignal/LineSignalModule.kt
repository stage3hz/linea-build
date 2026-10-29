package expo.modules.lineasignal

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LineSignalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaSignal")
    Constants("libsignalVersion" to SignalCore.VERSION)
    AsyncFunction("createState") { name: String, deviceId: Int -> protect { SignalCore.createState(name, deviceId) } }
    AsyncFunction("replenish") { state: String, count: Int -> protect { SignalCore.replenish(state, count) } }
    AsyncFunction("trustIdentity") { state: String, name: String, deviceId: Int, identity: String -> protect { SignalCore.trustIdentity(state, name, deviceId, identity) } }
    AsyncFunction("encrypt") { state: String, name: String, deviceId: Int, plaintext: String, bundle: Map<String, Any?>? -> protect { SignalCore.encrypt(state, name, deviceId, plaintext, bundle) } }
    AsyncFunction("decrypt") { state: String, name: String, deviceId: Int, type: Int, body: String -> protect { SignalCore.decrypt(state, name, deviceId, type, body) } }
    AsyncFunction("seal") { plaintext: String, key: String, nonce: String, ad: String -> protect { SignalCore.seal(plaintext, key, nonce, ad) } }
    AsyncFunction("open") { ciphertext: String, key: String, nonce: String, ad: String -> protect { SignalCore.open(ciphertext, key, nonce, ad) } }
  }

  // Do not propagate SDK exceptions containing protocol data into JS error logs.
  private inline fun <T> protect(body: () -> T): T = try { body() } catch (error: Exception) {
    val reason = (error as? SignalFailure)?.reason ?: "CRYPTO_FAILED"
    throw CodedException("ERR_LINEA_SIGNAL_$reason", "Signal operation rejected: $reason", null)
  }
}
