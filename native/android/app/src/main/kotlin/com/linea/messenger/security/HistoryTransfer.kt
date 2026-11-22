package com.linea.messenger.security

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.net.Live
import java.lang.ref.WeakReference
import java.time.Instant

/** Old chats on a new device (docs/HISTORY-TRANSFER.md), as the running app does it. The whole logic is the core's
 *  (`e2ee::history_sync`, the operations `history.*` of the encryption service): this only says when. (The previous
 *  app: `mobile/src/e2ee/historyRuntime.ts`; iOS: Security/HistoryTransfer.swift.)
 *  - At the start: a device without any cached chat asks for a copy once; a copy that is ready is imported; requests
 *    of newer own devices whose 10-minute wait is over are answered.
 *  - Live events `history.request` / `history.ready` / `history.backup` (net/Live.kt) bring those steps forward.
 *  - The encrypted backup is kept going every 30 minutes while the app runs. */
object HistoryTransfer {
  /** On a new device: when the copy from another device may start (the server's 10-minute wait). */
  var waitingUntil: String? = null
    private set
  /** The copy is being imported. */
  var receiving = false
    private set
  /** Messages imported on this device since the app started. */
  var imported = 0
    private set
  /** Told on the main thread when the status above changed. */
  val changed = Live.Signal<Unit>()

  private var account = WeakReference<Messenger>(null)
  private val main = Handler(Looper.getMainLooper())
  private val serveTask = Runnable { serve() }
  private val backupTask = Runnable { backup() }
  private val receiveTask = Runnable { receive() }
  private val heard: (Map<String, Any?>) -> Unit = { data ->
    when (data["type"]) {
      "history.request" -> serve()
      "history.ready" -> receive()
      "history.backup" -> backup()
    }
  }

  /** Called once by the signed-in account (shell/RootScreen.kt), after the keys were published. */
  fun start(messenger: Messenger?) {
    if (messenger == null) return
    account = WeakReference(messenger)
    waitingUntil = null; receiving = false; imported = 0
    for (task in listOf(serveTask, backupTask, receiveTask)) main.removeCallbacks(task)
    Live.historyEvent.unwatch(heard)
    Live.historyEvent.watch(heard)
    receive()
    serve()
    main.postDelayed(backupTask, 20_000)
  }

  private fun tell() = changed.post(Unit)

  fun millis(text: String?): Long? = try { if (text == null) null else Instant.parse(text).toEpochMilli() } catch (_: Exception) { null }

  /** Asks for a copy once (a device without cached chats), then imports one that is ready. */
  fun receive() {
    val messenger = account.get() ?: return
    messenger.crypto.call("history.ask") { asked ->
      val transfer = asked.getOrNull() as? Map<*, *>
      if (transfer != null && transfer["state"] == "waiting") waitingUntil = transfer["notBefore"] as? String
      receiving = true
      tell()
      messenger.crypto.call("history.receive") { result ->
        receiving = false
        val count = (result.getOrNull() as? Number)?.toInt()
        if (count != null) {
          imported += count
          waitingUntil = null
          messenger.noteChanged(null)
        } else if (waitingUntil != null) {
          // Still waiting: look again now and then (the live event usually comes first).
          main.removeCallbacks(receiveTask)
          main.postDelayed(receiveTask, 120_000)
        }
        tell()
      }
    }
  }

  /** Answers the requests of newer own devices whose wait is over; comes back when the next one is due. */
  fun serve() {
    val messenger = account.get() ?: return
    messenger.crypto.call("history.serve") { result ->
      val at = millis(result.getOrNull() as? String) ?: return@call
      main.removeCallbacks(serveTask)
      main.postDelayed(serveTask, maxOf(1_000L, at - System.currentTimeMillis() + 2_000L))
    }
  }

  /** Keeps the encrypted backup going (when it is on and this device holds its secret). */
  fun backup() {
    val messenger = account.get() ?: return
    messenger.crypto.call("history.backup") {
      main.removeCallbacks(backupTask)
      main.postDelayed(backupTask, 30 * 60_000L)
    }
  }
}
