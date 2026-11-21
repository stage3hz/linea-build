package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.words
import java.io.File
import kotlin.concurrent.thread

/** «Данные и память»: how much of the account's storage on the server is used, and the temporary files this
 *  phone keeps. (The previous app: `DataSection` and `ServerStorage` of `mobile/src/SettingsScreen.tsx`.)
 *
 *  The temporary files counted and cleared here are the attachments decrypted for viewing (`DecryptedFiles`):
 *  the only cache this app keeps that can be thrown away at any moment. Messages, keys and music are not touched. */
@SuppressLint("ViewConstructor")
class DataScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Данные и память") {
  private var limits: Map<String, Any?>? = null
  private var limitsFailed = false
  private var cacheBytes: Long? = null
  private var clearing = false
  private var doneWords = ""

  /** How much of something is used: a thin track, filled from the left. */
  private class ShareBar(context: Context, private val share: Float, private val fill: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
      val w = width.toFloat(); val h = height.toFloat()
      paint.color = Theme.veil(0.10f)
      canvas.drawRoundRect(0f, 0f, w, h, h / 2, h / 2, paint)
      if (share <= 0f) return
      paint.color = fill
      canvas.drawRoundRect(0f, 0f, maxOf(h, w * share), h, h / 2, h / 2, paint)
    }
  }

  override fun build() {
    fill()
    loadLimits()
    measure()
  }

  private fun loadLimits() {
    account.serverGet("/e2ee/limits") { result ->
      val fresh = result.getOrNull()
      if (fresh != null) limits = fresh else limitsFailed = true
      if (isAttachedToWindow) fill()
    }
  }

  /** The size of what `DecryptedFiles` has written to the cache and not removed yet. */
  private fun measure() {
    cacheBytes = null
    val area = context.cacheDir
    thread(name = "invizent-cache-size") {
      val total = temporaryBytes(area)
      main.post {
        cacheBytes = total
        if (isAttachedToWindow) fill()
      }
    }
  }

  private fun line(symbol: String, label: String, value: String): View {
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.addView(SymbolView(context, symbol, 18f, Theme.accent), LinearLayout.LayoutParams(dp(20f), dp(20f)))
    row.addView(context.words(label, 15f, Theme.text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10f) })
    val amount = context.words(value, 15f, Theme.text, 700)
    amount.gravity = Gravity.END
    row.addView(amount, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
    return row
  }

  private fun fill() {
    clear()
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    // «Файлы на сервере».
    val used = serverWords(limits, limitsFailed)
    val share = serverShare(limits)
    val server = LinearLayout(context)
    server.orientation = LinearLayout.VERTICAL
    server.addView(line("cloud", "Использовано", used), LinearLayout.LayoutParams(wide, wrap))
    server.addView(ShareBar(context, share, if (share > 0.9f) Theme.danger else Theme.accent), LinearLayout.LayoutParams(wide, dp(6f)).apply { topMargin = dp(10f) })
    limits?.let { server.addView(context.words(planWords(it["platina"] as? Boolean ?: false), 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(10f) }) }
    server.addView(context.words("Зашифрованные вложения из личных чатов. Сервер не может их прочитать.", 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(10f) })
    addGroup("Файлы на сервере", listOf(SettingsLook.inset(server, top = 16f, side = 16f, bottom = 16f)))

    // «Кэш на этом устройстве».
    val cacheWords = cacheBytes?.let { sizeWords(it.toDouble(), storage = false) } ?: "…"
    val clean = SettingsButton(context, "Очистить кэш", SettingsButton.Kind.SECONDARY)
    clean.setBusy(clearing)
    clean.onPress = { clearCache() }
    val device = LinearLayout(context)
    device.orientation = LinearLayout.VERTICAL
    device.addView(line("drive", "Временные файлы", cacheWords), LinearLayout.LayoutParams(wide, wrap))
    device.addView(context.words("Расшифрованные для просмотра вложения. Всё это можно скачать и расшифровать заново.", 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    device.addView(clean, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    if (doneWords.isNotEmpty()) device.addView(context.words(doneWords, 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    addGroup("Кэш на этом устройстве", listOf(SettingsLook.inset(device, top = 16f, side = 16f, bottom = 16f)))
  }

  private fun clearCache() {
    if (clearing) return
    clearing = true
    doneWords = ""
    fill()
    val app = context.applicationContext
    thread(name = "invizent-cache-clear") {
      DecryptedFiles.sweep(app)
      main.post {
        clearing = false
        doneWords = "Кэш очищен. Переписка, ключи шифрования и твои музыкальные файлы не затронуты."
        measure()
        if (isAttachedToWindow) fill()
      }
    }
  }

  companion object {
    /** The bytes of the decrypted attachments left in the cache area `area`. */
    fun temporaryBytes(area: File): Long {
      val folders = area.listFiles { file -> file.name.startsWith(DecryptedFiles.prefix) } ?: return 0
      return folders.sumOf { folder -> folder.walkTopDown().filter { it.isFile }.sumOf { it.length() } }
    }

    /** «1.3 МБ» / «20 ГБ», as the reference writes sizes (the core's `settingsSize`). */
    fun sizeWords(bytes: Double, storage: Boolean): String =
      Core.map(Core.view("settingsSize", listOf(maxOf(0.0, bytes))))?.get(if (storage) "storage" else "size") as? String ?: ""

    /** «1 ГБ / 20 ГБ» of the server's `limits`; «…» while they are asked, «Недоступно» when they did not come. */
    fun serverWords(limits: Map<String, Any?>?, failed: Boolean): String {
      if (limits == null) return if (failed) "Недоступно" else "…"
      val used = (limits["usedBytes"] as? Number)?.toDouble() ?: 0.0
      val whole = (limits["storageBytes"] as? Number)?.toDouble() ?: 0.0
      return sizeWords(used, storage = true) + " / " + sizeWords(whole, storage = true)
    }

    /** The used share of the storage, 0…1. */
    fun serverShare(limits: Map<String, Any?>?): Float {
      if (limits == null) return 0f
      val used = (limits["usedBytes"] as? Number)?.toDouble() ?: 0.0
      val whole = (limits["storageBytes"] as? Number)?.toDouble() ?: 0.0
      return minOf(1.0, used / maxOf(1.0, whole)).toFloat()
    }

    fun planWords(platina: Boolean): String =
      if (platina) "Видео до 10 ГБ, файлы до 4 ГБ (Platina), всего 40 ГБ." else "Видео до 10 ГБ, файлы до 2 ГБ, всего 20 ГБ. С Platina — файлы до 4 ГБ и 40 ГБ всего."
  }
}
