package expo.modules.lineacall

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

/**
 * Ongoing-call foreground service: a notification «Имя · Звонок · 0:42» with «Завершить» (CallStyle on Android 12+,
 * which also puts the call chip in the status bar), and — type microphone — the microphone keeps working while the
 * app is in the background. Started only from the app in the foreground (the call was just placed or answered), with
 * startService, so a refused startForeground (no microphone permission, a system limit) simply stops the service and
 * the call goes on as before.
 */
class CallService : Service() {
  /** What the notification shows. */
  data class Shown(val id: String, val name: String, val text: String, val endLabel: String, val channelName: String, val connectedAt: Long)

  companion object {
    const val ACTION_SHOW = "expo.modules.lineacall.SHOW"
    const val ACTION_HANGUP = "expo.modules.lineacall.HANGUP"
    const val EXTRA_ID = "id"
    const val EXTRA_NAME = "name"
    const val EXTRA_TEXT = "text"
    const val EXTRA_END = "endLabel"
    const val EXTRA_CHANNEL = "channelName"
    const val EXTRA_CONNECTED = "connectedAt"
    const val EXTRA_OPEN = "expo.modules.lineacall.OPEN"
    private const val CHANNEL_ID = "calls_ongoing"
    private const val NOTIFICATION_ID = 0x1CA11

    /** Module → JS events ("end" from «Завершить»). Set by LineCallModule while it is alive. */
    @Volatile var listener: ((String, String) -> Unit)? = null
    /** The call the notification shows, and what it shows (updates rebuild the same notification). */
    @Volatile var shown: Shown? = null
    @Volatile var running = false


    fun start(context: Context, shown: Shown): Boolean {
      // No microphone permission yet (the very first call asks for it): Android 14 would refuse the service. The app
      // calls start again once the microphone is open.
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
      this.shown = shown
      return try {
        val intent = Intent(context, CallService::class.java).setAction(ACTION_SHOW).putExtra(EXTRA_ID, shown.id)
        context.startService(intent) != null
      } catch (e: Exception) {
        this.shown = null; false
      }
    }

    fun update(context: Context, id: String, text: String, connectedAt: Long) {
      val current = shown ?: return
      if (current.id != id || !running) return
      val next = current.copy(text = text, connectedAt = connectedAt)
      shown = next
      post(context, next)
    }

    fun stop(context: Context, id: String) {
      val current = shown ?: return
      if (current.id != id) return
      shown = null
      try { context.stopService(Intent(context, CallService::class.java)) } catch (e: Exception) { /* not running */ }
      try { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) } catch (e: Exception) { /* gone */ }
    }

    private fun channel(context: Context, name: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      // Low importance: the notification is silent (the call already makes its own sounds) but stays visible.
      val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    private fun icon(context: Context): Int {
      // expo-notifications' monochrome icon (app.config.js «notification-icon.png»), else the app icon.
      val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      return if (id != 0) id else context.applicationInfo.icon
    }

    private fun build(context: Context, s: Shown, callStyle: Boolean): Notification {
      channel(context, s.channelName)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(EXTRA_OPEN, s.id)
      }
      val content = launch?.let { PendingIntent.getActivity(context, 1, it, flags) }
      val hangup = PendingIntent.getService(context, 2, Intent(context, CallService::class.java).setAction(ACTION_HANGUP).putExtra(EXTRA_ID, s.id), flags)
      val builder = Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(icon(context))
        .setContentTitle(s.name)
        .setContentText(s.text)
        .setCategory(Notification.CATEGORY_CALL)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
      if (content != null) builder.setContentIntent(content)
      if (s.connectedAt > 0) builder.setWhen(s.connectedAt).setShowWhen(true).setUsesChronometer(true)
      else builder.setShowWhen(false).setUsesChronometer(false)
      if (callStyle && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val person = Person.Builder().setName(s.name).setImportant(true).build()
        builder.setStyle(Notification.CallStyle.forOngoingCall(person, hangup))
      } else {
        builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, s.endLabel, hangup).build())
      }
      return builder.build()
    }

    /** Re-posts the notification of the running service (the system keeps it attached to the service: same id). */
    private fun post(context: Context, s: Shown) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      try { manager.notify(NOTIFICATION_ID, build(context, s, true)) }
      catch (e: Exception) { try { manager.notify(NOTIFICATION_ID, build(context, s, false)) } catch (ignored: Exception) { /* keep the old one */ } }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_HANGUP -> {
        val id = intent.getStringExtra(EXTRA_ID) ?: shown?.id
        if (id != null) listener?.invoke("end", id)
        shown = null
        finish()
      }
      ACTION_SHOW -> {
        val s = shown
        if (s == null || s.id != intent.getStringExtra(EXTRA_ID) || !foreground(s)) finish()
      }
      // Restarted by the system after the process died: there is no call any more.
      else -> finish()
    }
    return START_NOT_STICKY
  }

  private fun foreground(s: Shown): Boolean {
    // Android 14 refuses a microphone service without the runtime permission (SecurityException): check first.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
    for (callStyle in listOf(true, false)) {
      try {
        val notification = build(this, s, callStyle)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(NOTIFICATION_ID, notification)
        running = true
        return true
      } catch (e: Exception) { /* try without CallStyle, then give up */ }
    }
    return false
  }

  private fun finish() {
    running = false
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (e: Exception) { /* not foreground */ }
    stopSelf()
  }

  override fun onDestroy() { running = false; super.onDestroy() }

  // The app was swiped away from recents during a call: the call is gone with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    shown?.id?.let { listener?.invoke("end", it) }
    shown = null
    finish()
    super.onTaskRemoved(rootIntent)
  }
}
