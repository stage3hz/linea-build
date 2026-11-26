package com.linea.messenger.push

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.linea.messenger.MainActivity
import com.linea.messenger.R
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.settings.NotificationPrefs
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Push notifications on Android, as the previous app did them (mobile/src/push.ts): Firebase Cloud Messaging. The
 * server sends only the sender's name and «Новое сообщение» / «Входящий звонок» — message text stays end-to-end
 * encrypted and never reaches a notification. While the app is on the screen the live line already delivers
 * everything, so no notification is shown then.
 *
 * - Once the account is open: the five channels (PushChannels), the notification permission asked on Android 13+
 *   (the reference's `requestPermissionsAsync`), the FCM token registered for the signed-in session
 *   (`PUT /me/push {token, platform: "android"}`) and kept fresh (PushService.onNewToken); removed before signing out
 *   (`DELETE /me/push`, settings/AccountActions.kt).
 * - What this device managed is said in «Уведомления и звуки» (`status`, `text`), word for word the reference's.
 * - A tapped notification opens its chat (or the room of «зовёт в комнату»), once the account is open and unlocked.
 * - «Уведомления и звуки» per kind: whether a notification shows and sounds while the app runs in the background.
 */
object Push {
  /** The notification's accent, as the server and the previous app give it. */
  const val COLOR = 0xFF4C7DFF.toInt()
  private const val ASK = 0x5055

  /** pending — not asked yet; denied — the permission is off; unavailable — no Firebase in this build or no Google
   *  Play services; server-off — registered, but the server has no key for Android; on — working. */
  enum class Status { PENDING, DENIED, UNAVAILABLE, SERVER_OFF, ON }

  /** Posted on the main thread when `status` changed. */
  val changed = Live.Signal<Unit>()
  private val main by lazy { Handler(Looper.getMainLooper()) }

  @Volatile var status: Status = Status.PENDING
    private set(value) { if (field != value) { field = value; main.post { changed.post(Unit) } } }

  /** The window is on the screen (MainActivity onStart … onStop): a notification then is not shown. */
  @Volatile var front = false

  private var messenger = WeakReference<Messenger>(null)
  private var window = WeakReference<Activity>(null)
  private var app: Context? = null
  /** A tapped notification that came before the account (or behind the code lock): the chat or the room. */
  private var waiting: Pair<String?, String?>? = null

  /** The few words of «Уведомления и звуки»; empty when everything works (`pushStatusText` of push.ts). */
  fun text(value: Status = status): String = when (value) {
    Status.DENIED -> "Уведомления выключены в настройках системы."
    Status.UNAVAILABLE -> "Уведомления не настроены в этой сборке приложения."
    Status.SERVER_OFF -> "Сервер пока не отправляет уведомления на это устройство."
    else -> ""
  }

  /** The account is open: channels, the permission, the token. */
  fun start(activity: Activity, account: Messenger) {
    window = WeakReference(activity)
    app = activity.applicationContext
    messenger = WeakReference(account)
    PushChannels.ensure(activity)
    main.postDelayed({ deliver() }, 800)
    if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      try { activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK) } catch (_: Exception) { status = Status.DENIED }
      return
    }
    granted(activity.applicationContext)
  }

  /** MainActivity: the system's answer about the notification permission. True when it was this one's. */
  fun permissionResult(requestCode: Int, grants: IntArray): Boolean {
    if (requestCode != ASK) return false
    val context = app ?: return true
    if (grants.isNotEmpty() && grants[0] == PackageManager.PERMISSION_GRANTED) granted(context) else status = Status.DENIED
    return true
  }

  private fun granted(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    if (manager != null && !manager.areNotificationsEnabled()) { status = Status.DENIED; return }
    try {
      // No google-services.json in this build (no Firebase settings), or no Google Play services on the phone.
      if (FirebaseApp.getApps(context).isEmpty() && FirebaseApp.initializeApp(context) == null) { status = Status.UNAVAILABLE; return }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        val token = if (task.isSuccessful) task.result else null
        if (token.isNullOrEmpty()) status = Status.UNAVAILABLE else register(token)
      }
    } catch (_: Throwable) {
      status = Status.UNAVAILABLE
    }
  }

  /** The token for this session; a fresh one (PushService.onNewToken) comes here too. */
  fun register(token: String) {
    val account = messenger.get() ?: return
    account.server.op("registerPush", listOf(token, "android")) { result ->
      // As the reference: a failed request changes nothing.
      if (result.isSuccess) status = if (Core.map(result.getOrNull())?.get("enabled") == true) Status.ON else Status.SERVER_OFF
    }
  }

  /** Before signing out, so this device stops receiving pushes (`stopPush`); `done` on the main thread either way. */
  fun stop(account: Messenger, done: () -> Unit) {
    messenger = WeakReference(null)
    waiting = null
    account.server.op("unregisterPush", emptyList()) { _ ->
      main.post { status = Status.PENDING; done() }
    }
  }

  /** The account was closed (signed out, or the session ended elsewhere). */
  fun forget() {
    messenger = WeakReference(null)
    waiting = null
    status = Status.PENDING
  }

  /** Opening the app clears what is already on screen — but not the ringing of a call it was opened for. */
  fun cameBack(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    try {
      for (shown in manager.activeNotifications) {
        if (IncomingCall.isOurs(shown.id) || shown.notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) continue
        manager.cancel(shown.tag, shown.id)
      }
    } catch (_: Exception) { /* nothing to clear */ }
  }

  // Tapping

  /** The window was opened (or brought back) by a tapped notification: its chat or its room, once the account is open.
   *  True when the intent was one. */
  fun tapped(intent: Intent?): Boolean {
    intent ?: return false
    if (intent.getStringExtra("kind") == "birthday") return false
    val chatId = intent.getStringExtra("chatId")?.takeIf { it.isNotBlank() }
    val roomId = intent.getStringExtra("roomId")?.takeIf { it.isNotBlank() }
    if (chatId == null && roomId == null) return false
    intent.removeExtra("chatId")
    intent.removeExtra("roomId")
    waiting = chatId to roomId
    main.post { deliver() }
    return true
  }

  private fun deliver(tries: Int = 15) {
    val (chatId, roomId) = waiting ?: return
    val account = messenger.get()
    val activity = window.get() as? MainActivity
    if (account == null || activity == null || activity.isFinishing || com.linea.messenger.security.LockGate.isUp) {
      if (tries > 0) main.postDelayed({ deliver(tries - 1) }, 1000)
      return
    }
    waiting = null
    // «<имя> зовёт в комнату»: the room in «Каналы» (walking in stays a deliberate press on «Зайти»).
    if (roomId != null) { com.linea.messenger.rooms.RoomRouter.open(roomId); return }
    account.chats { result ->
      val chat = result.getOrNull()?.firstOrNull { it.id == chatId } ?: return@chats
      if (activity.isFinishing || activity.isDestroyed) return@chats
      activity.openChatOver(ChatTarget(chat.title, chat.id, chat.peerId, chat.peerLastRead))
    }
  }

  // Showing (PushService)

  /** The person's switches, read straight from the device's preferences (the service may run without the window):
   *  `show` and `sound` of «Личные чаты» or «Сообщества». */
  private fun flag(context: Context, group: String, name: String): Boolean {
    val text = try { context.getSharedPreferences("invizent.look", Context.MODE_PRIVATE).getString(NotificationPrefs.KEY, null) } catch (_: Exception) { null } ?: return true
    return try { JSONObject(text).optJSONObject(group)?.optBoolean(name, true) ?: true } catch (_: Exception) { true }
  }

  /** A chat notification the system did not show by itself (the app's process was in front of it): shown here
   *  unless the window is on the screen, with the person's switches per kind (push.ts `setNotificationHandler`) — a
   *  call always rings, a community message follows «Сообщества», everything else «Личные чаты»; «Отправить без
   *  звука» never sounds. Only the server's own words are shown: the sender's name and its fixed line. */
  fun present(context: Context, title: String, body: String, channel: String?, tag: String?, data: Map<String, String>) {
    if (front) return
    val kind = data["kind"]
    val group = when (kind) { "call" -> null; "community" -> "communities"; else -> "chats" }
    if (group != null && !flag(context, group, "show")) return
    val sound = kind != "silent" && (group == null || flag(context, group, "sound"))
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    PushChannels.ensure(context)
    val target = if (!sound) PushChannels.SILENT else channel?.takeIf { manager.getNotificationChannel(it) != null } ?: PushChannels.MESSAGES
    val launch = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    for ((key, value) in data) if (key == "chatId" || key == "roomId" || key == "kind") launch.putExtra(key, value)
    val code = (tag ?: data["chatId"] ?: data["roomId"] ?: "").hashCode()
    val open = PendingIntent.getActivity(context, code, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = Notification.Builder(context, target)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(COLOR)
      .setContentTitle(title)
      // The server's «📞 Входящий звонок» / «📞 Пропущенный звонок» read without the emoji here.
      .setContentText(com.linea.messenger.chatsplus.ChatRowLooks.withoutCallMark(body))
      .setAutoCancel(true)
      .setContentIntent(open)
      .apply { if (kind == "call") setCategory(Notification.CATEGORY_CALL) else setCategory(Notification.CATEGORY_MESSAGE) }
      .build()
    try { manager.notify(tag, 0x504E, notification) } catch (_: Exception) { /* notifications are off */ }
  }

  /** The server's data message of a call to a closed app (`kind: call`, `wake: '1'`, src/calls/incomingPush.ts): the
   *  full-screen ringing; where the phone would not show it, the ordinary ringing notification with the same words. */
  fun wake(context: Context, data: Map<String, String>) {
    val chatId = data["chatId"]?.takeIf { Regex("^[A-Za-z0-9_-]{1,80}$").matches(it) } ?: return
    if (data["kind"] != "call" || data["wake"] != "1") return
    // The app is on the screen: the call arrives by its own connection and rings there.
    if (front) return
    val name = data["title"]?.take(80)?.takeIf { it.isNotBlank() } ?: "INVIZENT"
    if (IncomingCall.show(context, chatId, name)) return
    present(context, name, data["message"] ?: "Входящий звонок", data["channelId"] ?: PushChannels.CALLS_RING, "call:$chatId", data)
  }
}
