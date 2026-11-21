package com.linea.messenger.links

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelsStore
import com.linea.messenger.chatsplus.UnreadTotal
import com.linea.messenger.people.FriendRequests
import com.linea.messenger.settings.AppIcons
import com.linea.messenger.settings.NotificationPrefs
import java.lang.ref.WeakReference

/** The number on the app's icon: unread chats, the communities' counters and the waiting requests to be friends — the
 *  same total the server sends in pushes while the app is closed. Off with «Бейдж на иконке» (Уведомления и звуки).
 *  (The previous app: `mobile/src/appBadge.ts` — on Android expo-notifications' `setBadgeCountAsync`, which tells the
 *  launcher by its badge broadcast where the launcher has one; «not supported here» is quietly nothing, as there.) */
object AppBadge {
  private var account = WeakReference<Messenger>(null)
  private var app: Context? = null
  private var last = -1
  private val apply: (Unit) -> Unit = { apply() }

  fun start(context: Context, messenger: Messenger) {
    account = WeakReference(messenger)
    app = context.applicationContext
    last = -1
    for (signal in listOf(ChannelsStore.changed, FriendRequests.changed, UnreadTotal.changed)) { signal.unwatch(apply); signal.watch(apply) }
    apply()
  }

  /** The total the icon shows: 0 when the badge is off. */
  fun total(enabled: Boolean, chats: Int, communities: Int, requests: Int): Int = if (enabled) maxOf(0, chats) + maxOf(0, communities) + maxOf(0, requests) else 0

  fun apply() {
    if (account.get() == null) return
    set(total(NotificationPrefs.flag("badge", "enabled"), UnreadTotal.total, ChannelsStore.badge, FriendRequests.incoming.size))
  }

  /** Clears the number (the account was left). */
  fun clear() { account = WeakReference(null); set(0) }

  private fun set(count: Int) {
    if (count == last) return
    last = count
    val context = app ?: return
    try {
      // The launcher's own badge broadcast (what the reference's library sends to launchers that read it).
      val launcher = AppIcons.icons.map { "com.linea.messenger.MainActivity" + it.alias }.firstOrNull { name ->
        context.packageManager.getComponentEnabledSetting(ComponentName(context.packageName, name)).let { it == PackageManager.COMPONENT_ENABLED_STATE_ENABLED || (it == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && name.endsWith("Outline")) }
      } ?: return
      val intent = Intent("android.intent.action.BADGE_COUNT_UPDATE")
        .putExtra("badge_count", count).putExtra("badge_count_package_name", context.packageName).putExtra("badge_count_class_name", launcher)
      context.sendBroadcast(intent)
    } catch (_: Exception) { last = -1 /* not supported here (some Android launchers have no badges) */ }
  }
}
