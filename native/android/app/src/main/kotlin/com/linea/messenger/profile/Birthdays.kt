package com.linea.messenger.profile

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.core.Core
import com.linea.messenger.people.PersonProfileScreen
import java.lang.ref.WeakReference
import java.time.ZonedDateTime

/** Birthday reminders for friends (the reference's birthdayNotifications.ts and birthday.ts `birthdayReminders`; iOS
 *  Profile/Birthdays.swift): local notifications on this phone — the day before at 10:00 and 20:00 («Иван: завтра
 *  день рождения»), on the day at 00:00 and 10:00 («Иван: сегодня день рождения!»). Nothing is sent to the server:
 *  the birthdays come with the chats this account already has (the server shares them with friends only). Archived
 *  chats are left out; at most 48 are pending. They are kept by the system's alarm clock (inexact, allowed while
 *  idle — no extra permission) and shown by `BirthdayReceiver`; tapping one opens that chat with the person's profile
 *  on top. On Android 13 and later showing notifications is asked once, at the first scheduling, never at the start. */
object BirthdayReminders {
  private const val most = 48
  private const val channel = "birthdays"
  private const val prefs = "linea.birthdays"
  private var messenger = WeakReference<Messenger>(null)
  private var host = WeakReference<View>(null)
  private var signature = ""
  private var askedAt = 0L
  private val main by lazy { Handler(Looper.getMainLooper()) }
  /** A tapped reminder that waits for the shell (chat id, person id, name). */
  private var waiting: Triple<String, String, String>? = null

  class Reminder(val at: ZonedDateTime, val title: String, val body: String)

  /** The reminders of one person, only those still ahead (birthday.ts `birthdayReminders`, word for word). The name
   *  is not declined (an app cannot decline arbitrary names), so it stands in the nominative. */
  fun reminders(name: String, birthday: String, now: ZonedDateTime = ZonedDateTime.now()): List<Reminder> {
    val day = AvatarCatalog.nextBirthday(birthday, now.toLocalDate()) ?: return emptyList()
    val tomorrow = "🎂 $name: завтра день рождения" to "Нажми, чтобы открыть профиль."
    val today = "🎉 $name: сегодня день рождения!" to "Нажми, чтобы открыть профиль и поздравить."
    return listOf(Triple(-1L, 10, tomorrow), Triple(-1L, 20, tomorrow), Triple(0L, 0, today), Triple(0L, 10, today)).mapNotNull { (offset, hour, words) ->
      val at = day.plusDays(offset).atTime(hour, 0).atZone(now.zone)
      if (at.isAfter(now)) Reminder(at, words.first, words.second) else null
    }
  }

  /** The account whose friends are remembered; `host`: a view of the shell (a tapped reminder opens there). */
  fun start(messenger: Messenger?, host: View) {
    this.host = WeakReference(host)
    messenger ?: return
    if (this.messenger.get() !== messenger) {
      this.messenger = WeakReference(messenger)
      signature = ""
      messenger.watch(watcher)
    }
    main.postDelayed({ refresh() }, 1500)
    waiting?.let { (chat, peer, name) -> waiting = null; main.postDelayed({ open(chat, peer, name) }, 600) }
  }

  private val watcher = object : Messenger.Watcher { override fun changed(chatId: String?) = changed() }

  /** The list of chats changed: the birthdays are asked again at most every ten minutes. */
  fun changed() { if (System.currentTimeMillis() - askedAt > 600_000) refresh() }

  private fun refresh() {
    val messenger = messenger.get() ?: return
    askedAt = System.currentTimeMillis()
    messenger.server.op("chats", emptyList()) { result ->
      val chats = (Core.map(result.getOrNull())?.get("chats") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      val people = chats.mapNotNull { chat ->
        val id = chat["id"] as? String ?: return@mapNotNull null
        val peer = Core.map(chat["peer"]) ?: return@mapNotNull null
        val birthday = peer["birthday"] as? String ?: ""
        if (birthday.isEmpty() || Core.map(chat["settings"])?.get("archived") == true) null
        else listOf(id, peer["id"] as? String ?: "", peer["displayName"] as? String ?: "", birthday)
      }
      main.post { schedule(people) }
    }
  }

  private fun schedule(people: List<List<String>>) {
    val view = host.get() ?: return
    val context = view.context.applicationContext
    val mark = people.map { it.joinToString(":") }.sorted().joinToString("|")
    if (mark == signature) return
    signature = mark
    val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    for (index in 0 until most) PendingIntent.getBroadcast(context, index, Intent(context, BirthdayReceiver::class.java), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let { alarms.cancel(it); it.cancel() }
    if (people.isEmpty()) return
    askPermission(view)
    val all = people.flatMap { person -> reminders(person[2], person[3]).map { it to person } }.sortedBy { it.first.at }.take(most)
    all.forEachIndexed { index, (reminder, person) ->
      val intent = Intent(context, BirthdayReceiver::class.java)
        .putExtra("title", reminder.title).putExtra("body", reminder.body)
        .putExtra("birthdayChatId", person[0]).putExtra("peerId", person[1]).putExtra("name", person[2]).putExtra("index", index)
      val pending = PendingIntent.getBroadcast(context, index, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      try { alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.at.toInstant().toEpochMilli(), pending) } catch (_: Exception) {}
    }
  }

  private fun askPermission(view: View) {
    if (Build.VERSION.SDK_INT < 33) return
    var c: Context? = view.context
    while (c is ContextWrapper && c !is Activity) c = c.baseContext
    val activity = c as? Activity ?: return
    if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val kept = activity.getSharedPreferences(prefs, Context.MODE_PRIVATE)
    if (kept.getBoolean("asked", false)) return
    kept.edit().putBoolean("asked", true).apply()
    try { activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0x4244) } catch (_: Exception) {}
  }

  /** Shows one reminder (from the receiver). While the app is open the reminder goes to the shade quietly. */
  fun show(context: Context, intent: Intent) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(channel) == null) {
      manager.createNotificationChannel(NotificationChannel(channel, "Дни рождения", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val open = Intent(context, com.linea.messenger.MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      .putExtra("kind", "birthday")
      .putExtra("birthdayChatId", intent.getStringExtra("birthdayChatId")).putExtra("peerId", intent.getStringExtra("peerId")).putExtra("name", intent.getStringExtra("name"))
    val index = intent.getIntExtra("index", 0)
    val tap = PendingIntent.getActivity(context, 0x4200 + index, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(context, channel) else android.app.Notification.Builder(context)
    builder.setSmallIcon(context.applicationInfo.icon).setContentTitle(intent.getStringExtra("title") ?: "").setContentText(intent.getStringExtra("body") ?: "")
      .setContentIntent(tap).setAutoCancel(true)
    try { manager.notify("birthday", index, builder.build()) } catch (_: SecurityException) { /* notifications refused */ }
  }

  /** A tapped birthday notification (the window got it): the chat, then the person's profile on top. False for any
   *  other intent. */
  fun tapped(intent: Intent?): Boolean {
    if (intent?.getStringExtra("kind") != "birthday") return false
    val chatId = intent.getStringExtra("birthdayChatId") ?: return false
    val peer = intent.getStringExtra("peerId") ?: ""
    val name = intent.getStringExtra("name") ?: ""
    if (messenger.get() == null || host.get() == null) { waiting = Triple(chatId, peer, name); return true }
    open(chatId, peer, name)
    return true
  }

  private fun open(chatId: String, peerId: String, name: String) {
    val messenger = messenger.get() ?: return
    val view = host.get() ?: return
    val stack = view.pages() ?: return
    while (stack.depth > 1) stack.pop(animated = false)
    val chat = ChatScreen(view.context, name, messenger, chatId, peerId) { stack.pop() }
    stack.push(chat, animated = false)
    val profile = PersonProfileScreen(view.context, messenger, peerId, name, chatId = chatId)
    profile.chatLink = ProfileChatLink(chat, chatId)
    stack.push(profile)
  }
}

/** Shows a birthday reminder when the system's alarm clock rings for it (not exported: only the app's own alarms). */
class BirthdayReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = BirthdayReminders.show(context, intent)
}
