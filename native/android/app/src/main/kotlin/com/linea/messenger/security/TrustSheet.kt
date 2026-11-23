package com.linea.messenger.security

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoFailure
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsNotice
import com.linea.messenger.settings.ThemeStore

/** «Защита чата»: the safety codes of the devices of a conversation (the person's and one's own other devices), to
 *  compare in person or over a channel already trusted; the new keys are confirmed once compared. The codes and the
 *  confirmation are the core's (`snapshot` / `approve` of the encryption service, the reference's `trustSnapshot` /
 *  `approveDevices`); private keys are never shown. (The previous app: `mobile/src/e2ee/TrustSheet.tsx`; iOS
 *  Security/TrustSheet.swift.) */
@SuppressLint("ViewConstructor")
class TrustSheet(context: Context, private val messenger: Messenger?, private val peerId: String) : NoticeSheet(context, "Защита чата") {
  private var snapshot: Map<String, Any?>? = null
  private var loading = false
  private var failure = ""
  private var busy = false
  private var checked = false
  private var revision = 0

  companion object {
    /** Opens the sheet over whatever is on the screen. */
    fun present(from: View, messenger: Messenger?, peerId: String) { TrustSheet(from.context, messenger, peerId).present(from) }

    /** The line «Переписка защищена сквозным шифрованием» of a profile: « · проверить устройства», an arrow, and a tap
     *  that opens the sheet (the reference's `onSecurity` of `UserProfile.tsx`). */
    fun attach(line: LinearLayout, words: TextView, messenger: Messenger?, peerId: String) {
      if (messenger == null || peerId.isEmpty() || peerId == messenger.userId) return
      words.text = words.text.toString() + " · проверить устройства"
      line.addView(SymbolView(line.context, "chevron.right", 12f, Theme.muted), LinearLayout.LayoutParams(line.context.px(14f), line.context.px(14f)))
      line.isClickable = true
      line.isFocusable = true
      line.setOnClickListener { present(line, messenger, peerId) }
    }

    /** The sample of the emulator check: two devices, one new. */
    val sample: Map<String, Any?> = mapOf("peerId" to "sample-peer", "devices" to listOf(
      mapOf("deviceName" to "iPhone 15", "code" to "3F2A 91C0 7B44 E1D9 0A6F 22B8 C513 9E07", "trusted" to false, "self" to false),
      mapOf("deviceName" to "MacBook", "code" to "A07C 5D1E 88F3 41B2 6C9A 0E5D 73F8 B214", "trusted" to true, "self" to true),
    ))
  }

  override fun build() = refresh()

  private fun refresh() {
    revision += 1
    val asked = revision
    loading = true; failure = ""; checked = false
    fill()
    val messenger = messenger ?: run {
      loading = false
      snapshot = sample
      fill()
      return
    }
    messenger.crypto.call("snapshot", listOf(peerId)) { result ->
      if (asked != revision) return@call
      loading = false
      val value = result.getOrNull()
      if (result.isSuccess) snapshot = Core.map(value) else failure = (result.exceptionOrNull() as? CryptoFailure)?.words?.takeIf { it.isNotEmpty() } ?: "Не удалось получить ключи."
      fill()
    }
  }

  private fun approve() {
    val snapshot = snapshot ?: return
    val messenger = messenger ?: return
    if (!checked || busy) return
    val asked = revision
    busy = true; failure = ""
    fill()
    messenger.crypto.call("approve", listOf(snapshot)) { result ->
      if (asked != revision) return@call
      busy = false
      if (result.isSuccess) {
        performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        goBack()
      } else {
        failure = (result.exceptionOrNull() as? CryptoFailure)?.words?.takeIf { it.isNotEmpty() } ?: "Не удалось сохранить проверку ключей."
        fill()
      }
    }
  }

  private fun fill() {
    clear()
    add(context.words("Сверь коды при личной встрече или по уже доверенному каналу связи. Для одной пары устройств код на обоих экранах должен совпадать. Приватные ключи здесь не показываются.", 14f, Theme.muted), 4f)
    if (loading) add(ProgressBar(context).apply { indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent) }, 16f)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { refresh() }), 16f)
    val devices = (snapshot?.get("devices") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
    for (device in devices) {
      val trusted = device["trusted"] as? Boolean ?: false
      val own = device["self"] as? Boolean ?: false
      val head = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
      head.addView(SymbolView(context, if (trusted) "ion:shield-checkmark-outline" else "ion:shield-outline", 22f, if (trusted) Theme.accent else Theme.danger), LinearLayout.LayoutParams(context.px(22f), context.px(22f)))
      val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
      texts.addView(context.words(if (own) "Твоё другое устройство" else "Устройство собеседника", 15f, Theme.text, 700))
      texts.addView(context.words((device["deviceName"] as? String ?: "") + " · " + (if (trusted) "ты подтвердил этот ключ" else "новый ключ"), 12f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
      head.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(9f) })
      val code = context.words(device["code"] as? String ?: "", 15f, Theme.text).apply { typeface = Typeface.MONOSPACE; letterSpacing = 0.8f / 15f }
      val card = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(context.px(15f), context.px(15f), context.px(15f), context.px(15f))
        background = GradientDrawable().apply { cornerRadius = 18 * resources.displayMetrics.density; setStroke(context.px(1f), if (trusted) ThemeStore.look.border else Theme.accent) }
      }
      card.addView(head)
      card.addView(code, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
      add(card, 16f)
    }
    val pending = devices.any { !(it["trusted"] as? Boolean ?: false) }
    if (pending) {
      val sentence = "Я сверил все новые коды с собеседником и своими устройствами."
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(0, context.px(8f), 0, context.px(8f))
        isClickable = true; isFocusable = true
        contentDescription = sentence
        isSelected = checked
        setOnClickListener { checked = !checked; fill() }
      }
      val mark = View(context).apply { background = GradientDrawable().apply { cornerRadius = 4 * resources.displayMetrics.density; setStroke(context.px(1.6f), Theme.accent); if (checked) setColor(Theme.accent) } }
      row.addView(mark, LinearLayout.LayoutParams(context.px(18f), context.px(18f)))
      row.addView(context.words(sentence, 13f, Theme.text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(10f) })
      add(row, 12f)
      val confirm = SettingsButton(context, "Подтвердить проверенные ключи", icon = "shield-checkmark-outline")
      confirm.isEnabled = checked && !loading
      confirm.alpha = if (confirm.isEnabled) 1f else 0.5f
      if (busy) confirm.setBusy(true)
      confirm.onPress = { approve() }
      add(confirm, 8f)
    } else if (snapshot != null) {
      add(SettingsNotice(context, "Ключи этих устройств подтверждены. При появлении нового устройства приложение снова запросит проверку."), 16f)
    }
    add(context.words("Смена пароля не восстанавливает утраченные ключи истории. На новом телефоне сообщения, отправленные до добавления его ключа, могут быть недоступны.", 12f, Theme.muted), 16f)
  }
}
