package com.linea.messenger.crypto

import android.os.Handler
import android.os.Looper
import com.linea.messenger.core.Core
import com.linea.messenger.core.CryptoHost
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.storage.Vault
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/** Why an operation of the encryption service did not give its answer: the kind (`UntrustedDeviceError`,
 *  `NetworkError`, `PartialSync`, `Error`) and the words for the person. */
class CryptoFailure(val name: String, val words: String) : Exception(name)

/** The signed-in person's end-to-end encryption on this device.
 *
 *  All the logic — keys, trust, what is sent to whom, what is remembered — is the shared core's; this class
 *  gives it the private storage and the server and runs it on one thread of its own, one operation at a time.
 *  Nothing decrypted leaves the device, and nothing here is written to logs. */
class CryptoService(userId: String, private val vault: Vault, private val server: Server) : CryptoHost {
  private val queue: ExecutorService = Executors.newSingleThreadExecutor { work -> Thread(work, "invizent.crypto") }
  private val main = Handler(Looper.getMainLooper())
  /** Read and written on the service's own thread only (but for the making, before that thread has any work). */
  private var handle: Long = if (Core.loaded) Core.cryptoNew(userId, true, this) else 0L

  // What the core asks in the middle of an operation, on the service's thread.

  override fun vaultGet(key: String): String? = vault.get(key)

  /** A storage that cannot be written is not something to carry on from: keys and ratchets would be lost. The
   *  throw (of the storage, or of a list that is not one) stops the app in the core's hands. */
  override fun vaultCommit(changesJson: String) {
    val list = Core.value(changesJson) as? List<*> ?: throw IllegalStateException("The private storage was given no changes.")
    vault.commit(list.mapNotNull { item ->
      val pair = item as? List<*> ?: return@mapNotNull null
      val key = (if (pair.size == 2) pair[0] as? String else null) ?: return@mapNotNull null
      key to (pair[1] as? String)
    })
  }

  override fun transport(method: String, argsJson: String): String {
    val list = Core.value(argsJson) as? List<*> ?: emptyList<Any?>()
    // The core's `cryptoInbox` is the server's inbox page.
    val result = server.opAndWait(if (method == "cryptoInbox") "inboxPage" else method, list)
    val answer: Map<String, Any?> = when (val error = result.exceptionOrNull()) {
      null -> mapOf("ok" to result.getOrNull())
      is ServerError.Refused -> mapOf("refused" to error.words)
      is ServerError -> mapOf("network" to error.words)
      else -> mapOf("network" to "Нет связи с сервером.")
    }
    return Core.text(answer) ?: "{\"network\":\"Нет связи с сервером.\"}"
  }

  /** Runs one operation (names and arguments: the core's `e2ee::dispatch`); the answer comes on the main thread. */
  fun call(op: String, args: List<Any?> = emptyList(), done: (Result<Any?>) -> Unit) = run({ it.callNow(op, args) }, done)

  /** The same on the service's own thread, for work that chains several operations; `done` on the main thread.
   *  After `close` nothing runs and nothing is answered. */
  fun <T> run(work: (CryptoService) -> T, done: (T) -> Unit) {
    try {
      queue.execute {
        val result = work(this)
        main.post { done(result) }
      }
    } catch (_: RejectedExecutionException) {}
  }

  /** One operation, on the current (the service's) thread. A failure is a `CryptoFailure`. */
  fun callNow(op: String, args: List<Any?> = emptyList()): Result<Any?> {
    val unavailable = Result.failure<Any?>(CryptoFailure("Error", "Шифрование недоступно."))
    val argsText = Core.text(args)
    if (handle == 0L || argsText == null) return unavailable
    val answer = Core.map(Core.value(Core.cryptoCall(handle, op, argsText))) ?: return unavailable
    val error = Core.map(answer["error"])
    if (error != null) return Result.failure(CryptoFailure(error["name"] as? String ?: "Error", error["message"] as? String ?: ""))
    return Result.success(answer["ok"])
  }

  /** Ends the service after the work already given to it, then closes the storage; nothing may be asked afterwards. */
  fun close() {
    try {
      queue.execute {
        val ended = handle
        handle = 0L
        if (ended != 0L) Core.cryptoFree(ended)
        vault.close()
      }
    } catch (_: RejectedExecutionException) {}
    queue.shutdown()
  }

  companion object {
    fun failure(result: Result<*>): CryptoFailure? = result.exceptionOrNull() as? CryptoFailure
  }
}
