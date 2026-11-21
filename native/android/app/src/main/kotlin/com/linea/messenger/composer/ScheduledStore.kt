package com.linea.messenger.composer

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoFailure
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError

/** «Отправить позже» (iOS: Sources/Composer/ScheduledStore.swift; the reference's useMessenger.ts `performSend` with
 *  `deliverAt`): the message is encrypted now, for the devices of now, dated at the chosen time inside the
 *  ciphertext, and the server keeps the envelopes (never decrypted) until then. Runs on the encryption thread.
 *
 *  `true`: the server keeps it for later. `false`: the time passed meanwhile and it went out at once (not an error).
 *  The kept ciphertext is forgotten when the server refuses for good. */
fun Messenger.deliverLater(crypto: CryptoService, chatId: String, peerId: String, clientId: String, text: Any?, attachment: Any?, meta: Any?, deliverAt: String, again: Boolean = true): Result<Boolean> {
  val encrypted = crypto.callNow("encrypt", listOf(chatId, peerId, clientId, text, attachment, meta, deliverAt, null))
  if (encrypted.isFailure) return Result.failure(CryptoService.failure(encrypted) ?: CryptoFailure("Error", "Шифрование недоступно."))
  val kind = Core.view("callPushKind", listOf(meta)) as? String
  val args = arrayListOf<Any?>(chatId, clientId, encrypted.getOrNull(), deliverAt)
  if (kind == "silent") args.add("silent")
  val kept = server.opAndWait("scheduleEncrypted", args)
  if (kept.isSuccess) {
    crypto.callNow("delivered", listOf(chatId, clientId))
    return Result.success(true)
  }
  val error = Server.error(kept)
  if (error !is ServerError.Refused) return Result.failure(CryptoFailure("NetworkError", error.words))
  if (error.code == "SCHEDULE_IN_PAST") {
    // A time that passed while the phone was offline: the very same envelopes go out now.
    val now = server.opAndWait("sendEncrypted", listOf(chatId, clientId, encrypted.getOrNull()) + listOfNotNull(kind))
    if (now.isFailure) return Result.failure(CryptoFailure("NetworkError", Server.error(now).words))
    crypto.callNow("delivered", listOf(chatId, clientId))
    return Result.success(false)
  }
  if (error.code == "E2EE_DEVICES_CHANGED") {
    crypto.callNow("forget", listOf(chatId, clientId))
    if (again) return deliverLater(crypto, chatId, peerId, clientId, text, attachment, meta, deliverAt, again = false)
    return Result.failure(CryptoFailure("Error", error.words))
  }
  if (error.status == 400 && error.words.contains("неизвестные поля")) {
    crypto.callNow("forget", listOf(chatId, clientId))
    return Result.failure(CryptoFailure("Error", "Сервер не поддерживает отложенные сообщения."))
  }
  if (error.status in 400..499 && error.status != 401 && error.status != 408 && error.status != 429) crypto.callNow("forget", listOf(chatId, clientId))
  return Result.failure(CryptoFailure("Error", error.words))
}

/** The scheduled messages of the account (the reference's useMessenger.ts `scheduled`): the server's list (ciphertext
 *  and time) opened with this device's vault — a message encrypted here is kept under its clientId, so its text shows;
 *  one scheduled from another device stays closed. Main thread only. */
class ScheduledStore private constructor(private val messenger: Messenger) {
  companion object {
    /** Posted on the main thread when the list or what is being done with it changed. */
    val changed = Live.Signal<Unit>()
    private var made: ScheduledStore? = null

    /** The store of an account (one per signed-in person). */
    fun of(messenger: Messenger): ScheduledStore {
      made?.let { if (it.messenger === messenger) return it }
      return ScheduledStore(messenger).also { made = it }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  var items: List<ScheduledItem> = emptyList()
    private set
  /** Items being sent now or deleted (their buttons wait). */
  val busy = HashSet<String>()
  private var revision = 0
  private val resending = HashSet<String>()
  /** A server without scheduled messages answers 404 on the list: asked no more in this session. */
  private var supported = true
  /** The other person of a chat, as the open chats know it. */
  private val peers = HashMap<String, String>()

  init {
    Live.scheduledEvent.watch { data -> if (data["type"] == "ready") online() else refresh() }
  }

  fun remember(chatId: String, peerId: String) { if (peerId.isNotEmpty()) peers[chatId] = peerId }

  /** The live line opened: what was scheduled but never confirmed (the app was closed meanwhile) goes to the server
   *  again with its very ciphertext, and the list is read. */
  fun online() {
    val messenger = messenger
    messenger.crypto.run({ crypto ->
      val pending = (crypto.callNow("pendingOutbox").getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }
      var done = 0
      for (item in pending) {
        val deliverAt = item["deliverAt"] as? String ?: continue
        val chatId = item["chatId"] as? String ?: continue
        val clientId = item["clientId"] as? String ?: continue
        val peerId = item["peerId"] as? String ?: continue
        val result = messenger.deliverLater(crypto, chatId, peerId, clientId, item["text"] ?: "", item["attachment"], item["meta"], deliverAt)
        if (result.isSuccess) done += 1 else if (CryptoService.failure(result)?.name == "NetworkError") break
      }
      done
    }, { done ->
      if (done > 0) messenger.noteChanged(null)
      refresh()
    })
  }

  /** Reads the server's list again (lean: no ciphertext over the wire; the text is in the vault). */
  fun refresh() {
    if (!supported) return
    revision += 1
    val asked = revision
    val me = messenger.userId
    messenger.crypto.run({ crypto ->
      val listed = messenger.server.opAndWait("scheduled", listOf(mapOf("lean" to true)))
      if (listed.isFailure) return@run Result.failure<List<ScheduledItem>>(Server.error(listed))
      val rows = (Core.map(listed.getOrNull() as? Map<*, *>)?.get("items") as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }
      val opened = rows.mapNotNull { row ->
        val item = ScheduledItem.parse(row) ?: return@mapNotNull null
        val probe = linkedMapOf<String, Any?>("id" to 0, "chatId" to item.chatId, "senderId" to me, "clientId" to item.clientId, "text" to "", "attachment" to null, "createdAt" to item.createdAt)
        if (item.encrypted != null) probe["encrypted"] = item.encrypted else probe["lean"] = true
        val shown = Core.map(crypto.callNow("preview", listOf(probe)).getOrNull() as? Map<*, *>)
        if (shown != null) {
          item.cryptoState = shown["cryptoState"] as? String ?: ""
          if (item.cryptoState == "decrypted") {
            item.text = shown["text"] as? String ?: ""
            item.attachment = Core.map(shown["attachment"] as? Map<*, *>)
            item.meta = Core.map(shown["meta"] as? Map<*, *>)
          }
        } else item.cryptoState = "no-key"
        item
      }
      Result.success(opened)
    }, { result ->
      if (asked != revision) return@run
      val list = result.getOrNull()
      if (list != null) {
        items = list.sortedBy { it.deliverAt }
        changed.post(Unit)
        for (item in items) if (item.canResend) resend(item) {}
      } else {
        val error = result.exceptionOrNull() as? ServerError.Refused
        if (error != null && error.status == 404 && error.code == null) supported = false
      }
    })
  }

  /** The scheduled messages of one chat, the soonest first. */
  fun items(chatId: String): List<ScheduledItem> = items.filter { it.chatId == chatId }

  private fun setBusy(id: String, on: Boolean) {
    if (on) busy.add(id) else busy.remove(id)
    changed.post(Unit)
  }

  private fun drop(id: String) {
    items = items.filter { it.id != id }
    changed.post(Unit)
  }

  /** A message the server could not release (the other side's devices changed) is encrypted afresh here — only this
   *  device holds the text — and sent the ordinary way; the stale row goes. `done`: null or the words of the problem. */
  fun resend(item: ScheduledItem, done: (String?) -> Unit) {
    if (item.cryptoState != "decrypted" || resending.contains(item.id)) return done(null)
    resending.add(item.id)
    val peerId = peers[item.chatId]
    messenger.crypto.run({ crypto ->
      if (peerId == null) return@run "Сначала открой разговор."
      crypto.callNow("forget", listOf(item.chatId, item.clientId))
      val gone = messenger.server.opAndWait("deleteScheduled", listOf(item.id))
      val refused = gone.exceptionOrNull() as? ServerError.Refused
      if (refused != null && refused.status != 404) return@run refused.words
      val sent = messenger.deliver(crypto, item.chatId, peerId, item.clientId, item.text, item.attachment, item.meta)
      if (sent.isSuccess) null else (CryptoService.failure(sent)?.words ?: "Не удалось отправить.")
    }, { problem ->
      resending.remove(item.id)
      if (problem == null) {
        drop(item.id)
        messenger.noteChanged(item.chatId)
      }
      done(problem)
    })
  }

  /** «Отправить сейчас»: the server releases the stored envelopes; when they no longer fit the other side's devices
   *  (409), this device encrypts the text afresh. `done`: null or the words of the problem. */
  fun sendNow(item: ScheduledItem, done: (String?) -> Unit) {
    setBusy(item.id, true)
    val finish: (String?) -> Unit = { problem -> setBusy(item.id, false); done(problem) }
    if (item.failed) {
      if (!item.canResend) return finish("Отправить заново можно только с устройства, где сообщение написано.")
      return resend(item, finish)
    }
    messenger.server.op("sendScheduledNow", listOf(item.id)) { result ->
      main.post {
        if (result.isSuccess) {
          drop(item.id)
          messenger.noteChanged(item.chatId)
          finish(null)
          return@post
        }
        val error = Server.error(result)
        if (error is ServerError.Refused && error.status == 409) {
          if (item.cryptoState != "decrypted") return@post finish("Отправить заново можно только с устройства, где сообщение написано.")
          resend(item, finish)
        } else finish(error.words)
      }
    }
  }

  /** The bin: the message is deleted before it is sent, and its copy in this device's vault goes too. */
  fun delete(item: ScheduledItem, done: (String?) -> Unit) {
    setBusy(item.id, true)
    messenger.server.op("deleteScheduled", listOf(item.id)) { result ->
      main.post {
        setBusy(item.id, false)
        if (result.isFailure) {
          val error = Server.error(result)
          if (!(error is ServerError.Refused && error.status == 404)) return@post done(error.words)
        }
        drop(item.id)
        messenger.crypto.run({ crypto -> crypto.callNow("forget", listOf(item.chatId, item.clientId)); Unit }, { })
        done(null)
      }
    }
  }
}
