package com.linea.messenger.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.linea.messenger.MainActivity
import com.linea.messenger.R
import com.linea.messenger.calls.CallState
import com.linea.messenger.calls.Calls

/**
 * The call as the phone itself shows it, as the previous app did (mobile/modules/linea-call/android/CallService.kt
 * driven by src/calls/systemCall.ts): an ongoing-call foreground service of the type «microphone» with a notification
 * «Имя · Звонок · 0:42» and «Завершить звонок» (CallStyle on Android 12+, which also puts the call chip in the status
 * bar). It keeps the call going — and the microphone working (Android 11+ silences a background microphone without
 * one) — while the app is in the background. A tap opens the call screen.
 *
 * It follows the call (Calls.changed): started when a call is placed or answered, its text and duration updated,
 * stopped when the call ends. Everything is optional: no microphone permission yet or a service the system does not
 * allow leave the call exactly as it was (it runs in the app, without the system indicator).
 */
object OngoingCall {
  /** The call the notification shows (null: none). */
  private data class Shown(val id: String, val name: String, val text: String, val connectedAt: Long)

  const val EXTRA_OPEN = "invizent.ongoing.open"
  internal const val ACTION_SHOW = "com.linea.messenger.ONGOING_SHOW"
  internal const val ACTION_HANGUP = "com.linea.messenger.ONGOING_HANGUP"
  internal const val EXTRA_ID = "id"
  internal const val CHANNEL_ID = "calls_ongoing"
  internal const val NOTIFICATION_ID = 0x1CA11

  @Volatile private var shown: Shown? = null
  @Volatile internal var running = false
  private var app: Context? = null
  private val watch: (Unit) -> Unit = { follow() }

  /** Once, at start (MainActivity): the service follows the call from now on. */
  fun install(context: Context) {
    if (app != null) return
    app = context.applicationContext
    Calls.changed.watch(watch)
  }

  /** The window was opened from the notification: the call screen comes back. True when it was this. */
  fun opened(intent: Intent?): Boolean {
    if (intent?.getStringExtra(EXTRA_OPEN) == null) return false
    intent.removeExtra(EXTRA_OPEN)
    val call = Calls.call
    if (call != null && !call.isOver) Calls.restore()
    return true
  }

  /** The words of the system indicator (systemCallText of the reference's callStatus.ts). */
  internal fun text(call: CallState): String = when {
    call.status == "active" && !call.reconnecting -> if (call.video) "Видеозвонок" else "Звонок"
    call.status == "active" -> "Восстановление связи…"
    call.status == "ringing" -> "Вызов…"
    else -> "Соединение…"
  }

  private fun follow() {
    val context = app ?: return
    val call = Calls.call
    val current = shown
    // Over, or nothing: the service goes.
    if (call == null || call.isOver) { if (current != null) stop(context); return }
    // An incoming call is shown by the call screen until it is answered (the reference starts the service then).
    if (call.status == "incoming") return
    val next = Shown(call.id, call.peer.displayName.ifBlank { "Собеседник" }, text(call), if (call.status == "active") call.startedAt?.toLong() ?: 0L else 0L)
    if (current == null || current.id != call.id) {
      if (current != null) stop(context)
      start(context, next)
    } else if (current != next) {
      shown = next
      if (running) post(context)
    }
  }

  private fun start(context: Context, s: Shown) {
    // No microphone permission yet (the very first call asks for it): Android 14 would refuse the service. The next
    // change of the call (the microphone open) tries again.
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
    shown = s
    try {
      if (context.startService(Intent(context, OngoingCallService::class.java).setAction(ACTION_SHOW).putExtra(EXTRA_ID, s.id)) == null) shown = null
    } catch (_: Exception) { shown = null }
  }

  private fun stop(context: Context) {
    shown = null
    try { context.stopService(Intent(context, OngoingCallService::class.java)) } catch (_: Exception) { /* not running */ }
    try { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) } catch (_: Exception) { /* gone */ }
  }

  internal fun current(id: String?): Boolean = shown?.id == id && id != null

  private fun channel(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // Low importance: the notification is silent (the call already makes its own sounds) but stays visible.
    val made = NotificationChannel(CHANNEL_ID, "Текущий звонок", NotificationManager.IMPORTANCE_LOW)
    made.setShowBadge(false)
    manager.createNotificationChannel(made)
  }

  internal fun build(context: Context, callStyle: Boolean): Notification? {
    val s = shown ?: return null
    channel(context)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val launch = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_OPEN, s.id)
    val content = PendingIntent.getActivity(context, 21, launch, flags)
    val hangup = PendingIntent.getService(context, 22, Intent(context, OngoingCallService::class.java).setAction(ACTION_HANGUP).putExtra(EXTRA_ID, s.id), flags)
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(Push.COLOR)
      .setContentTitle(s.name)
      .setContentText(s.text)
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setContentIntent(content)
    if (s.connectedAt > 0) builder.setWhen(s.connectedAt).setShowWhen(true).setUsesChronometer(true)
    else builder.setShowWhen(false).setUsesChronometer(false)
    if (callStyle && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = Person.Builder().setName(s.name).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forOngoingCall(person, hangup))
    } else {
      builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Завершить звонок", hangup).build())
    }
    return builder.build()
  }

  /** Re-posts the notification of the running service (the system keeps it attached to the service: same id). */
  private fun post(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    try { build(context, true)?.let { manager.notify(NOTIFICATION_ID, it) } }
    catch (_: Exception) { try { build(context, false)?.let { manager.notify(NOTIFICATION_ID, it) } } catch (_: Exception) { /* keep the old one */ } }
  }

  /** «Завершить звонок» in the notification, or the app swiped away from recents during the call. */
  internal fun hungUp(id: String?) {
    if (id == null || shown?.id != id) return
    shown = null
    val call = Calls.call
    if (call != null && call.id == id && !call.isOver) Calls.hangup()
  }
}

/** The foreground service itself. Not exported: only the app starts it. */
class OngoingCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      OngoingCall.ACTION_HANGUP -> { OngoingCall.hungUp(intent.getStringExtra(OngoingCall.EXTRA_ID)); finish() }
      OngoingCall.ACTION_SHOW -> if (!OngoingCall.current(intent.getStringExtra(OngoingCall.EXTRA_ID)) || !foreground()) finish()
      // Restarted by the system after the process died: there is no call any more.
      else -> finish()
    }
    return START_NOT_STICKY
  }

  private fun foreground(): Boolean {
    // Android 14 refuses a microphone service without the runtime permission (SecurityException): checked first.
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
    for (callStyle in listOf(true, false)) {
      try {
        val notification = OngoingCall.build(this, callStyle) ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startForeground(OngoingCall.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(OngoingCall.NOTIFICATION_ID, notification)
        OngoingCall.running = true
        return true
      } catch (_: Exception) { /* try without CallStyle, then give up */ }
    }
    return false
  }

  private fun finish() {
    OngoingCall.running = false
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { /* not foreground */ }
    stopSelf()
  }

  override fun onDestroy() { OngoingCall.running = false; super.onDestroy() }

  // The app was swiped away from recents during a call: the call is gone with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    Calls.call?.let { OngoingCall.hungUp(it.id) }
    finish()
    super.onTaskRemoved(rootIntent)
  }
}
