package com.linea.messenger.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase

/** The choices the person made in the previous app, carried over once at the first start after the update.
 *
 *  The previous app kept them in React Native's AsyncStorage (@react-native-async-storage/async-storage 2.2, the
 *  classic storage — `AsyncStorage_useNextStorage` is off): the SQLite database `databases/RKStorage`, table
 *  `catalystLocalStorage (key, value)`. It is opened READ-ONLY and never changed or removed.
 *
 *  Each value is written under the key and in the preferences this app reads (the same JSON text), and only where
 *  this app has nothing yet — a choice made in this app always wins, and a later run (the next update) changes
 *  nothing. Done once: a mark is kept when it has run. */
object OldAppSettings {
  private const val MARK_PREFS = "invizent.migration"
  private const val MARK = "old-settings-imported.v1"

  /** The previous app's key (or a prefix ending in ":" / ".", for per-account entries) → this app's preferences
   *  file and key. */
  private class Entry(val old: String, val prefs: String, val new: String) {
    val prefix get() = old.endsWith(":") || old.endsWith(".")
  }

  private val table = listOf(
    Entry("linea.notification-prefs.v1", "invizent.look", "invizent.notification-prefs.v1"), // «Уведомления и звуки»
    Entry("linea.chat-preferences.v1", "invizent.look", "invizent.chat-preferences.v1"),     // text size, power saving, night theme, accent, effects…
    Entry("linea.theme.v1", "invizent.look", "invizent.theme.v1"),                           // «Оформление»: the theme
    Entry("linea.dark-theme.v1", "invizent.look", "invizent.dark-theme.v1"),                 // the night theme
    Entry("linea.wallpapers.v1", "invizent.look", "invizent.wallpapers.v1"),                 // chat wallpapers
    Entry("linea.stickers.recent.v1", "invizent.look", "invizent.emoji.recent.v1"),          // recent emoji
    Entry("linea.language.v1", "invizent.language", "linea.language.v1"),                    // «Язык»
    Entry("linea.folders.v1:", "chatsplus", "linea.folders.v1:"),                            // «Папки с чатами», per account
    Entry("linea.hint.bar-scrub.v1", "chatsplus", "linea.hint.bar-scrub.v1"),                // the tab bar hint shown
    Entry("linea.hidden.v1:", "invizent.chat-local", "invizent.hidden.v1:"),                 // messages deleted for me
    Entry("linea.removed-chats.v1:", "invizent.chat-local", "invizent.removed-chats.v1:"),   // chats deleted for me
    Entry("linea.marked-unread.v1:", "invizent.chat-local", "invizent.marked-unread.v1:"),   // chats marked unread
    Entry("linea.seen-posts.v1:", "invizent.stories", "linea.seen-posts.v1:"),               // stories seen
    Entry("linea.recent-search.v1:", "linea.recent-search", "linea.recent-search.v1:"),      // recent search
    Entry("linea.platina.seen.", "linea.platina", "linea.platina.seen."),                    // Platina offer seen
    Entry("linea.channel-outbox.v1:", "linea.channels", "linea.channel-outbox.v1:"),         // channel messages not sent yet
    Entry("linea.equalizer.v1", "linea.music", "linea.equalizer.v1"),                        // music: equalizer
    Entry("linea.music-source.v1", "linea.music", "linea.music-source.v1"),                  // music: the chosen source
    Entry("linea.music.device-library.v1", "linea.music", "linea.music.device-library.v1"),  // music: saved tracks and favourites
    Entry("linea.session-user.v1", "invizent", "invizent.session-user.v1"),                  // the account's last profile
  )

  /** At start, before anything reads its settings. */
  fun importOnce(context: Context) {
    val app = context.applicationContext
    val marks = app.getSharedPreferences(MARK_PREFS, Context.MODE_PRIVATE)
    if (marks.getBoolean(MARK, false)) return
    try {
      val old = read(app)
      for ((key, value) in old) {
        val entry = table.firstOrNull { key == it.old || (it.prefix && key.startsWith(it.old)) } ?: continue
        val target = entry.new + key.substring(entry.old.length)
        val prefs = app.getSharedPreferences(entry.prefs, Context.MODE_PRIVATE)
        if (prefs.contains(target)) continue
        prefs.edit().putString(target, value).apply()
      }
    } catch (_: Exception) { /* nothing carried over; this app's own defaults stay */ }
    marks.edit().putBoolean(MARK, true).apply()
  }

  /** The previous app's AsyncStorage as key → text; empty when there is none. */
  fun read(context: Context): Map<String, String> {
    val file = context.getDatabasePath("RKStorage")
    if (!file.isFile) return emptyMap()
    val out = LinkedHashMap<String, String>()
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
      db.rawQuery("SELECT key, value FROM catalystLocalStorage", null).use { rows ->
        while (rows.moveToNext()) {
          val key = rows.getString(0) ?: continue
          val value = rows.getString(1) ?: continue
          out[key] = value
        }
      }
    }
    return out
  }
}
