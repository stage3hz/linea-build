package expo.modules.lineacall

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * An incoming call while the app is closed (src/calls/incomingPush.ts): a ringing, full-screen notification.
 * On a locked or idle phone the system opens the app over the lock screen (the «full-screen intent»); on a phone in
 * use it is a heads-up card with «Ответить» / «Отклонить». Both «Ответить» and a tap open the app, which then shows
 * its own call screen; «Отклонить» only puts the notification away (the caller's ring runs out as a missed call).
 */
object IncomingCall {
  const val EXTRA_CHAT = "invizent.incoming.chat"
  const val EXTRA_ANSWER = "invizent.incoming.answer"
  const val ACTION_DECLINE = "expo.modules.lineacall.DECLINE_INCOMING"
  private const val CHANNEL_ID = "calls-incoming"
  private const val NOTIFICATION_ID = 7402
  /** As long as the caller rings (the push itself lives 45 s). */
  private const val RING_MS = 45_000L
  /** The app stays allowed over the lock screen this long after it was opened for a call, unless a call is up. */
  private const val OVER_LOCK_MS = 60_000L

  /** What the app was opened for, taken once by the call screen: the chat and whether «Ответить» was pressed. */
  @Volatile private var pending: Pair<String, Boolean>? = null
  /** When it was set: an opening that no call followed must not answer a later call by itself. */
  @Volatile private var pendingAt = 0L
  private val main = Handler(Looper.getMainLooper())
  private var release: Runnable? = null

  private fun channel(context: Context, name: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_HIGH)
    // Our own ringtone (assets/sounds/call_ring.ogg, placed in res/raw by expo-notifications), else the phone's.
    val raw = context.resources.getIdentifier("call_ring", "raw", context.packageName)
    val sound: Uri? = if (raw != 0) Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/$raw") else RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    if (sound != null) channel.setSound(sound, attributes)
    channel.enableVibration(true)
    channel.vibrationPattern = longArrayOf(0, 800, 500, 800, 500, 800, 500, 800, 500, 800)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  private fun icon(context: Context): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  private fun open(context: Context, chatId: String, answer: Boolean, code: Int): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    launch.putExtra(EXTRA_CHAT, chatId)
    launch.putExtra(EXTRA_ANSWER, answer)
    return PendingIntent.getActivity(context, code, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** False when the phone would not show it (no launcher intent, notifications blocked): the caller keeps the
   *  ordinary notification then. */
  fun show(context: Context, chatId: String, name: String, text: String, answerLabel: String, declineLabel: String, channelName: String): Boolean {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (!manager.areNotificationsEnabled()) return false
    val full = open(context, chatId, false, 11) ?: return false
    val answer = open(context, chatId, true, 12) ?: return false
    val decline = PendingIntent.getBroadcast(context, 13, Intent(context, IncomingCallReceiver::class.java).setAction(ACTION_DECLINE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    channel(context, channelName)
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(icon(context))
      .setContentTitle(name)
      .setContentText(text)
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setAutoCancel(true)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setTimeoutAfter(RING_MS)
      .setContentIntent(full)
      .setFullScreenIntent(full, true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = Person.Builder().setName(name).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(person, decline, answer))
    } else {
      builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, declineLabel, decline).build())
      builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, answerLabel, answer).build())
    }
    return try { manager.notify(NOTIFICATION_ID, builder.build()); true } catch (e: Exception) { false }
  }

  fun dismiss(context: Context) {
    try { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) } catch (e: Exception) { /* gone */ }
  }

  /** The activity was started (or brought back) by the notification: remember why, put the notification away and
   *  let the app show over the lock screen for the call. */
  fun opened(activity: Activity?, intent: Intent?) {
    val chatId = intent?.getStringExtra(EXTRA_CHAT) ?: return
    val answer = intent.getBooleanExtra(EXTRA_ANSWER, false)
    intent.removeExtra(EXTRA_CHAT)
    intent.removeExtra(EXTRA_ANSWER)
    pending = Pair(chatId, answer)
    pendingAt = android.os.SystemClock.elapsedRealtime()
    if (activity != null) { dismiss(activity.applicationContext); overLock(activity, true, OVER_LOCK_MS) }
  }

  fun take(): Map<String, Any>? {
    val value = pending ?: return null
    pending = null
    if (android.os.SystemClock.elapsedRealtime() - pendingAt > OVER_LOCK_MS) return null
    return mapOf("chatId" to value.first, "answer" to value.second)
  }

  /**
   * Whether the app may show over the lock screen. On for a call only: left on, anyone holding the locked phone
   * could open the chats. `forMs` > 0: switched off by itself after that long (the call never came up).
   */
  fun overLock(activity: Activity?, on: Boolean, forMs: Long = 0) {
    if (activity == null) return
    main.post {
      release?.let { main.removeCallbacks(it) }
      release = null
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { activity.setShowWhenLocked(on); activity.setTurnScreenOn(on) }
      } catch (e: Exception) { /* the activity is going away */ }
      if (on && forMs > 0) {
        val later = Runnable { overLock(activity, false) }
        release = later
        main.postDelayed(later, forMs)
      }
    }
  }
}

/** «Отклонить» on the incoming-call notification. */
class IncomingCallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == IncomingCall.ACTION_DECLINE) IncomingCall.dismiss(context)
  }
}
