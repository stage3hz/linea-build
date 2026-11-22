package com.linea.messenger.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentResolver
import android.content.Context
import android.media.AudioAttributes
import android.net.Uri
import android.provider.Settings
import com.linea.messenger.R

/** The notification channels, exactly as the previous app made them, so the phone keeps the person's choices for
 *  each and the server's `channel_id` finds them (server/src/push.js):
 *  - `messages` «Сообщения», `calls` «Звонки», `calls-ring` «Входящие звонки», `silent` «Без звука» — the
 *    reference's `channels()` (mobile/src/push.ts), through expo-notifications;
 *  - `calls-incoming` «Входящие звонки» — the full-screen ringing of a call that woke the closed app
 *    (mobile/modules/linea-call/android/IncomingCall.kt).
 *  A channel's sound cannot be changed once it exists: the names, sounds and vibration stay as they were. */
object PushChannels {
  const val MESSAGES = "messages"
  const val CALLS = "calls"
  const val CALLS_RING = "calls-ring"
  const val SILENT = "silent"
  const val CALLS_INCOMING = "calls-incoming"

  private val messagesVibration = longArrayOf(0, 180, 120, 180)
  private val callsVibration = longArrayOf(0, 600, 400, 600, 400, 600)
  internal val ringVibration = longArrayOf(0, 800, 500, 800, 500, 800, 500, 800, 500, 800)

  /** Our own ringtone (res/raw/call_ring.ogg, the reference's assets/sounds/call_ring.ogg). */
  internal fun ringtone(context: Context): Uri = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/${R.raw.call_ring}")

  private val ringAttributes: AudioAttributes
    get() = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()

  /** expo-notifications' `sound: 'default'`: the phone's notification sound with the notification's attributes. */
  private fun defaultSound(channel: NotificationChannel) {
    channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
  }

  fun ensure(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    try {
      val messages = NotificationChannel(MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH).apply {
        defaultSound(this); enableVibration(true); vibrationPattern = messagesVibration; lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      }
      val calls = NotificationChannel(CALLS, "Звонки", NotificationManager.IMPORTANCE_MAX).apply {
        defaultSound(this); enableVibration(true); vibrationPattern = callsVibration; lockscreenVisibility = Notification.VISIBILITY_PUBLIC; setBypassDnd(false)
      }
      // An incoming call while the app is closed: our own ringtone and a long vibration, also on the lock screen.
      val ring = NotificationChannel(CALLS_RING, "Входящие звонки", NotificationManager.IMPORTANCE_MAX).apply {
        setSound(ringtone(context), ringAttributes); enableVibration(true); vibrationPattern = ringVibration; lockscreenVisibility = Notification.VISIBILITY_PUBLIC; setBypassDnd(false)
      }
      val silent = NotificationChannel(SILENT, "Без звука", NotificationManager.IMPORTANCE_LOW).apply {
        setSound(null, null); vibrationPattern = longArrayOf(0); enableVibration(false)
      }
      manager.createNotificationChannels(listOf(messages, calls, ring, silent))
      incoming(context, manager)
    } catch (_: Exception) { /* the system refused: notifications fall back to the default channel */ }
  }

  /** The full-screen ringing's channel (IncomingCall.kt of the reference), made once. */
  internal fun incoming(context: Context, manager: NotificationManager) {
    if (manager.getNotificationChannel(CALLS_INCOMING) != null) return
    val channel = NotificationChannel(CALLS_INCOMING, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH)
    channel.setSound(ringtone(context), ringAttributes)
    channel.enableVibration(true)
    channel.vibrationPattern = ringVibration
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }
}
