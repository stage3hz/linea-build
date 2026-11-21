package com.linea.messenger.linkpreview

import android.content.Context
import android.view.View
import com.linea.messenger.settings.SettingsSwitchRow

/** «Предпросмотр ссылок»: whether this phone fetches the page of a link the person writes, to send its card
 *  along. Kept on this device only (the server knows nothing of it). When it is off nothing is ever fetched;
 *  cards that arrive inside messages are still shown — they cost no request to anyone. */
object LinkSettings {
  private const val PREFERENCES = "invizent.links"
  private const val KEY = "linkPreviews.off"
  const val label = "Предпросмотр ссылок"
  const val words = "Когда ты пишешь ссылку, телефон сам загружает страницу и прикладывает её карточку к зашифрованному сообщению. Сервер ссылку не видит, а телефон собеседника на сайт не заходит. Если выключить, страницы не загружаются; карточки от собеседников показываются по-прежнему."

  private fun store(context: Context) = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun on(context: Context): Boolean = !store(context).getBoolean(KEY, false)

  fun set(context: Context, value: Boolean) {
    store(context).edit().putBoolean(KEY, !value).apply()
    // Switched off: the cards made so far are not kept for a later message either.
    if (!value) LinkFetcher.shared.forget()
  }

  /** The switch for the privacy page of the settings. */
  fun row(context: Context): View {
    val row = SettingsSwitchRow(context, label, words, value = on(context))
    row.onChange = { value -> set(context, value) }
    return row
  }
}
