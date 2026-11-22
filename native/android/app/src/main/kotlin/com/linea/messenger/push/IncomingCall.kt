package com.linea.messenger.push

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.MainActivity
import com.linea.messenger.R

/**
 * An incoming call while the app is closed, as the previous app did it (mobile/modules/linea-call/android/IncomingCall.kt
 * and src/calls/incomingPush.ts): the server's data message wakes the app (PushService), which shows a ringing,
 * full-screen notification. On a locked or idle phone the system opens the app over the lock screen (the «full-screen
 * intent»); on a phone in use it is a heads-up card with «Ответить» / «Отклонить». Both «Ответить» and a tap open the
 * app, which connects, finds the call and shows its own call screen (calls/CallEngine.kt `rings` asks `callUp`);
 * «Отклонить» only puts the notification away (the caller's ring runs out as a missed call).
 * Nothing here decrypts anything: the notification carries only who calls.
 */
object IncomingCall {
  const val EXTRA_CHAT = "invizent.incoming.chat"
  const val EXTRA_ANSWER = "invizent.incoming.answer"
  const val ACTION_DECLINE = "com.linea.messenger.DECLINE_INCOMING"
  private const val NOTIFICATION_ID = 7402
  /** As long as the caller rings: a minute (the push itself lives 60 s). */
  private const val RING_MS = 60_000L
  /** The app stays allowed over the lock screen this long after it was opened for a call, unless a call is up. */
  private const val OVER_LOCK_MS = 60_000L

  /** What the app was opened for, taken once by the call screen: the chat and whether «Ответить» was pressed. */
  @Volatile private var pending: Pair<String, Boolean>? = null
  /** When it was set: an opening that no call followed must not answer a later call by itself. */
  @Volatile private var pendingAt = 0L
  private val main by lazy { Handler(Looper.getMainLooper()) }
  private var release: Runnable? = null

  private fun open(context: Context, chatId: String, answer: Boolean, code: Int): PendingIntent {
    val launch = Intent(context, MainActivity::class.java)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    launch.putExtra(EXTRA_CHAT, chatId)
    launch.putExtra(EXTRA_ANSWER, answer)
    return PendingIntent.getActivity(context, code, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** False when the phone would not show it (notifications blocked): the caller keeps the ordinary notification then. */
  fun show(context: Context, chatId: String, name: String, text: String = "Входящий звонок", answerLabel: String = "Ответить", declineLabel: String = "Отклонить"): Boolean {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
    if (!manager.areNotificationsEnabled()) return false
    val full = open(context, chatId, false, 11)
    val answer = open(context, chatId, true, 12)
    val decline = PendingIntent.getBroadcast(context, 13, Intent(context, IncomingCallReceiver::class.java).setAction(ACTION_DECLINE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    PushChannels.incoming(context, manager)
    val builder = Notification.Builder(context, PushChannels.CALLS_INCOMING)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(Push.COLOR)
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
    // The ringtone file is 25 s long and a notification plays its sound once: «insistent» repeats it until the
    // notification goes away (answered, declined, or the minute is over).
    val notification = builder.build()
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    return try { manager.notify(NOTIFICATION_ID, notification); true } catch (_: Exception) { false }
  }

  fun dismiss(context: Context) {
    try { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) } catch (_: Exception) { /* gone */ }
  }

  /** Whether `id` is the ringing notification (kept when the app clears what is on screen). */
  internal fun isOurs(id: Int) = id == NOTIFICATION_ID

  /** The window was started (or brought back) by the notification: remember why and let the app show over the lock
   *  screen for the call. The notification — and with it the ringtone — stays until the app's own call screen is up
   *  and rings itself (`callUp`); «Ответить» was pressed: nothing is left to ring for. */
  fun opened(activity: Activity?, intent: Intent?) {
    val chatId = intent?.getStringExtra(EXTRA_CHAT) ?: return
    val answer = intent.getBooleanExtra(EXTRA_ANSWER, false)
    intent.removeExtra(EXTRA_CHAT)
    intent.removeExtra(EXTRA_ANSWER)
    pending = Pair(chatId, answer)
    pendingAt = SystemClock.elapsedRealtime()
    if (activity != null) { if (answer) dismiss(activity.applicationContext); overLock(activity, true, OVER_LOCK_MS) }
  }

  /** The app's call screen is up with the incoming call of `chatId` (calls/CallEngine.kt `rings`): the ringing
   *  notification goes, and «Ответить» pressed on it answers here, once the call is on screen (the reference's
   *  CallProvider: `dismissIncomingCall`, `takeIncomingCall`, accept after 400 ms). */
  fun callUp(context: Context, chatId: String, accept: () -> Unit) {
    dismiss(context)
    val value = pending ?: return
    pending = null
    if (SystemClock.elapsedRealtime() - pendingAt > OVER_LOCK_MS) return
    if (value.second && value.first == chatId) main.postDelayed({ accept() }, 400)
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
      } catch (_: Exception) { /* the activity is going away */ }
      if (on && forMs > 0) {
        val later = Runnable { overLock(activity, false) }
        release = later
        main.postDelayed(later, forMs)
      }
    }
  }
}

/** «Отклонить» on the incoming-call notification. Not exported: only the app's own notification reaches it. */
class IncomingCallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == IncomingCall.ACTION_DECLINE) IncomingCall.dismiss(context)
  }
}
