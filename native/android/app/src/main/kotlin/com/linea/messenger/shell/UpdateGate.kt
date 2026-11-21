package com.linea.messenger.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.chatsplus.PlusIconView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import com.linea.messenger.settings.ThemeStore
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

/** Shell: the update the account's server offers and whether it is mandatory for this build (the reference's
 *  update/store.ts, update/UpdateScreen.tsx and update/install.ts; native/ios/Sources/Shell/UpdateGate.swift).
 *  `GET /app/update` answers even builds the server otherwise turns away (426), so an outdated app always learns where
 *  to get the new version.
 *  - Mandatory (below `minVersion`, or the grace period after `requiredAt` is over, or any answer 426): a screen over
 *    the whole app that cannot be put away.
 *  - Optional: a window with «Позже», shown once per version; it comes back on a cold start and after the app was away
 *    for five minutes or more.
 *  The deadline is on the server's clock (a wrong phone clock does not move it) and checked every 30 s, so the app
 *  locks at the exact moment. Asked only of the signed-in account's own server.
 *  On Android, as the reference: «Установить» downloads the build's APK from this project's releases, checks its size
 *  and SHA-256 and hands it to the system installer — the person still confirms the installation in the system's
 *  window; nothing is installed silently. Main thread only (except `markRequired`). */
object UpdateGate {
  const val REPROMPT_AFTER_MS = 5 * 60_000L
  private const val GITHUB_PREFIX = "https://github.com/stage3hz/linea-build/releases/download/"

  class Asset(val url: String, val sha256: String, val size: Long)

  class Info(
    val version: String?, val minVersion: String?, val page: String?, val android: Asset?,
    /** Milliseconds on the SERVER's clock. */
    val releasedAt: Long?, val requiredAt: Long?,
    /** The server's time minus the phone's. */
    val clockOffset: Long,
  )

  var info: Info? = null
    private set
  var mandatory = false
    private set
  var available = false
    private set
  var dismissed = false
    private set
  private var server: Server? = null
  private var window: ViewGroup? = null
  private var screen: UpdateScreen? = null
  private var leftAt: Long? = null
  private val main = Handler(Looper.getMainLooper())
  private val clock = object : Runnable {
    override fun run() { recheckDeadline(); screen?.refresh(); main.postDelayed(this, 30_000) }
  }
  /** The optional window is on the screen (the system's Back puts it off, as the reference's Modal does). */
  val optionalShown: Boolean get() = screen != null && !mandatory

  /** The installed build's version (versionName). */
  var appVersion = "0.0.0"
    private set

  fun start(messenger: Messenger?, host: View) {
    window = host.rootView.findViewById(android.R.id.content) ?: host.rootView as? ViewGroup
    appVersion = try { host.context.packageManager.getPackageInfo(host.context.packageName, 0).versionName ?: "0.0.0" } catch (_: Exception) { "0.0.0" }
    main.removeCallbacks(clock)
    main.postDelayed(clock, 30_000)
    ShellDemo.update?.let { demo ->
      val now = System.currentTimeMillis()
      info = Info("9.0.0", if (demo == "required") "9.0.0" else null, "https://github.com/stage3hz/linea-build/releases",
        Asset(GITHUB_PREFIX + "v9.0.0/INVIZENT-9.0.0.apk", "0".repeat(64), 58_000_000), now - 2 * 3_600_000, now + (2 * 86_400_000 + 14 * 3_600_000 + 5 * 60_000), 0)
      // Once the app's window is on screen.
      main.postDelayed({ publish(kept = false) }, 1000)
      return
    }
    // Only the account's own server is asked (never a server the person did not choose).
    val messenger = messenger ?: return
    server = Server(messenger.server.base)
    check()
  }

  /** Any answer 426: the server has retired this build. From any thread. */
  fun markRequired() {
    main.post {
      if (mandatory) return@post
      mandatory = true
      available = true
      dismissed = false
      show()
      check()
    }
  }

  /** The app left the screen. */
  fun wentAway() { leftAt = System.currentTimeMillis() }

  /** «Every time the app is opened»: the window returns after the app was away a while. */
  fun cameBack() {
    val left = leftAt
    if (left != null && System.currentTimeMillis() - left >= REPROMPT_AFTER_MS && dismissed) {
      dismissed = false
      show()
    }
    leftAt = null
    check()
  }

  fun check() {
    val server = server ?: return
    server.send("GET", "/app/update") { result ->
      val raw = com.linea.messenger.core.Core.map(result.getOrNull()) ?: return@send
      main.post { take(raw) }
    }
  }

  private fun time(value: Any?): Long? = Messenger.date(value as? String)?.toEpochMilli()

  /** A release asset of this project. The address is parsed, not compared as text (update/store.ts `releaseAssetUrl`). */
  fun releaseAssetUrl(url: String): Boolean {
    if (url.any { it.isWhitespace() || it in "\"'<>\\%" } || url.contains("..")) return false
    return try {
      val parsed = URI(url)
      parsed.toString() == url && parsed.scheme == "https" && parsed.host == "github.com" && parsed.rawUserInfo == null && parsed.rawQuery == null &&
        parsed.rawFragment == null && parsed.rawPath.startsWith("/stage3hz/linea-build/releases/download/")
    } catch (_: Exception) { false }
  }

  fun asset(raw: Any?): Asset? {
    val fields = com.linea.messenger.core.Core.map(raw) ?: return null
    val url = fields["url"] as? String ?: return null
    val sha = fields["sha256"] as? String ?: return null
    val size = (fields["size"] as? Number)?.toDouble() ?: return null
    if (!releaseAssetUrl(url) || !url.startsWith(GITHUB_PREFIX) || !Regex("^[0-9a-f]{64}$").matches(sha)) return null
    if (size <= 0 || size != Math.floor(size) || size > 9_007_199_254_740_991.0) return null
    return Asset(url, sha, size.toLong())
  }

  private fun take(raw: Map<String, Any?>) {
    val serverTime = time(raw["serverTime"])
    val version = raw["version"] as? String
    val minimum = raw["minVersion"] as? String
    val made = Info(version?.takeIf { parse(it) != null }, minimum?.takeIf { parse(it) != null }, raw["page"] as? String, asset(raw["android"]),
      time(raw["releasedAt"]), time(raw["requiredAt"]), serverTime?.let { it - System.currentTimeMillis() } ?: 0)
    val sameVersion = info?.version == made.version
    info = made
    publish(kept = dismissed && sameVersion)
  }

  private fun publish(kept: Boolean) {
    val info = info ?: return
    val decided = decide(info, appVersion, System.currentTimeMillis())
    // A 426 already heard stays mandatory.
    mandatory = mandatory || decided.first
    available = mandatory || decided.second
    dismissed = if (mandatory) false else kept
    show()
  }

  private fun recheckDeadline() {
    val info = info ?: return
    if (mandatory) return
    if (decide(info, appVersion, System.currentTimeMillis()).first) {
      mandatory = true; available = true; dismissed = false
      show()
    }
  }

  /** «Позже» (the optional window only). */
  fun dismissUpdate() {
    if (mandatory) return
    dismissed = true
    show()
  }

  /** The window came or went (the system's Back follows it). */
  var onChange: (() -> Unit)? = null

  /** The window or the screen, as the state says. */
  private fun show() {
    main.post { onChange?.invoke() }
    val shown = screen
    if (shown != null) {
      if (!available || (dismissed && !mandatory)) {
        screen = null
        shown.animate().alpha(0f).setDuration(200).withEndAction { (shown.parent as? ViewGroup)?.removeView(shown) }.start()
        return
      }
      shown.mandatory = mandatory
      shown.refresh()
      return
    }
    if (!available || (dismissed && !mandatory)) return
    val window = window ?: return
    val made = UpdateScreen(window.context, mandatory)
    screen = made
    made.alpha = 0f
    window.addView(made, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    made.animate().alpha(1f).setDuration(200).start()
  }

  // The rules (update/store.ts)

  fun parse(value: String?): List<Int>? {
    val text = value?.trim() ?: return null
    val match = Regex("^(\\d{1,4})\\.(\\d{1,4})\\.(\\d{1,5})$").matchEntire(text) ?: return null
    return match.groupValues.drop(1).map { it.toInt() }
  }

  fun less(a: String, b: String): Boolean {
    val pa = parse(a) ?: return false
    val pb = parse(b) ?: return false
    for (index in 0 until 3) if (pa[index] != pb[index]) return pa[index] < pb[index]
    return false
  }

  /** (mandatory, available) for an answer of the server. */
  fun decide(info: Info, current: String, nowMs: Long): Pair<Boolean, Boolean> {
    val newer = info.version?.let { less(current, it) } ?: false
    val serverNow = nowMs + info.clockOffset
    val required = (info.minVersion?.let { less(current, it) } ?: false) || (newer && info.requiredAt != null && serverNow >= info.requiredAt)
    return required to (required || newer)
  }

  /** «2 д 14 ч 05 мин» / «14 ч 05 мин» / «5 мин». */
  fun span(ms: Long): String {
    val total = maxOf(0L, ms / 60_000)
    val days = total / 1440; val hours = (total % 1440) / 60; val minutes = total % 60
    val two = String.format(Locale.ROOT, "%02d", minutes)
    if (days > 0) return "$days д $hours ч $two мин"
    if (hours > 0) return "$hours ч $two мин"
    return "${maxOf(1, minutes)} мин"
  }

  // Installing (update/install.ts)

  /** Where the work is: the step and how far (0…1). */
  class Phase(val step: String, val progress: Float)

  private val work = Executors.newSingleThreadExecutor()

  /** Download → verify SHA-256 → hand to the system installer. `onPhase` and `done` (null, or the words of what went
   *  wrong) on the main thread. */
  fun install(context: Context, asset: Asset, version: String, onPhase: (Phase) -> Unit, done: (String?) -> Unit) {
    val app = context.applicationContext
    work.execute {
      fun phase(step: String, progress: Float) { main.post { onPhase(Phase(step, progress)) } }
      fun fail(words: String) { main.post { done(words) } }
      // The same folder kind as a file being shown: a fresh one, read by the installer through the app's own provider.
      val folder = File(app.cacheDir, DecryptedFiles.prefix + UUID.randomUUID().toString().lowercase())
      val target = File(folder, "INVIZENT-" + version.filter { it.isDigit() || it == '.' } + ".apk")
      try {
        folder.mkdirs()
        phase("download", 0f)
        val request = Request.Builder().url(asset.url).header("Cache-Control", "no-store").build()
        val client = Server.client.newBuilder().followRedirects(true).followSslRedirects(false).build()
        client.newCall(request).execute().use { response ->
          // A release asset is served from GitHub's own download host after one redirect: HTTPS only, checked by the system.
          if (!response.isSuccessful || !response.request.url.isHttps) { folder.deleteRecursively(); return@execute fail("Не удалось скачать обновление. Проверь интернет.") }
          val body = response.body ?: run { folder.deleteRecursively(); return@execute fail("Не удалось скачать обновление. Проверь интернет.") }
          val total = if (body.contentLength() > 0) body.contentLength() else asset.size
          val digest = MessageDigest.getInstance("SHA-256")
          var written = 0L
          body.byteStream().use { input ->
            target.outputStream().use { output ->
              val chunk = ByteArray(256 * 1024)
              while (true) {
                val got = input.read(chunk)
                if (got < 0) break
                written += got
                if (written > asset.size) { folder.deleteRecursively(); return@execute fail("Файл загрузился не полностью. Попробуй ещё раз.") }
                output.write(chunk, 0, got)
                digest.update(chunk, 0, got)
                phase("download", minOf(1f, written.toFloat() / total))
              }
            }
          }
          phase("verify", 1f)
          if (written != asset.size) { folder.deleteRecursively(); return@execute fail("Файл загрузился не полностью. Попробуй ещё раз.") }
          val hex = digest.digest().joinToString("") { String.format(Locale.ROOT, "%02x", it) }
          if (hex != asset.sha256) { folder.deleteRecursively(); return@execute fail("Файл обновления повреждён или подменён — установка отменена.") }
        }
        phase("install", 1f)
        val address: Uri = DecryptedFiles.address(app, DecryptedFiles.Written(folder, target))
        main.post {
          try {
            val open = Intent(Intent.ACTION_VIEW).setDataAndType(address, "application/vnd.android.package-archive")
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(open)
            done(null)
          } catch (_: Exception) { done("Не удалось обновить приложение.") }
        }
      } catch (_: IOException) {
        folder.deleteRecursively()
        fail("Не удалось скачать обновление. Проверь интернет.")
      } catch (_: Exception) {
        folder.deleteRecursively()
        fail("Не удалось обновить приложение.")
      }
    }
  }

  /** The screen of an update (UpdateScreen.tsx): the card with the cloud, the words, the versions, «Вышло … назад» and
   *  «Обязательно через …», «Установить» (or the way to the download page) and, while optional, «Позже». */
  @SuppressLint("ViewConstructor")
  class UpdateScreen(context: Context, var mandatory: Boolean) : FrameLayout(context) {
    private val card = LinearLayout(context)
    private val heading = context.words("", 22f, Theme.text, 800).apply { gravity = Gravity.CENTER; letterSpacing = -0.4f / 22f }
    private val body = context.words("", 14f, Theme.muted).apply { gravity = Gravity.CENTER; setLineSpacing(0f, 1.1f) }
    private val versions = context.words("", 12f, Theme.muted).apply { gravity = Gravity.CENTER }
    private val boxes = LinearLayout(context)
    private val releasedBox = box(context, "Вышло", tinted = false)
    private val leftBox = box(context, "Обязательно через", tinted = true)
    private val progress = Progress(context)
    private val progressWords = context.words("", 12f, Theme.muted).apply { gravity = Gravity.CENTER }
    private val error = context.words("", 13f, Theme.danger).apply { gravity = Gravity.CENTER }
    private val button = LinearLayout(context)
    private val buttonIcon = PlusIconView(context, "download", 16f, Theme.onAccent)
    private val buttonWords = context.words("", 16f, Theme.onAccent, 600)
    private val later = context.words("Позже", 14f, Theme.muted).apply { gravity = Gravity.CENTER; setPadding(context.px(10f), context.px(10f), context.px(10f), context.px(10f)) }
    private var phase: Phase? = null
    private var opened = false

    init {
      isClickable = true
      card.orientation = LinearLayout.VERTICAL
      card.setPadding(context.px(24f), context.px(24f), context.px(24f), context.px(24f))
      card.background = context.plate(if (Theme.dark) 0xFF151B2C.toInt() else Color.WHITE, 28f, ThemeStore.look.border)
      card.gravity = Gravity.CENTER_HORIZONTAL
      val badge = FrameLayout(context).apply { background = context.plate(ThemeStore.look.accentSoft, 22f) }
      badge.addView(PlusIconView(context, "cloud.down", 32f, Theme.accent), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      fun gap(view: View, size: Float = 16f, height: Int = LinearLayout.LayoutParams.WRAP_CONTENT, width: Int = LinearLayout.LayoutParams.MATCH_PARENT) =
        card.addView(view, LinearLayout.LayoutParams(width, height).apply { topMargin = if (card.childCount == 0) 0 else context.px(size) })
      gap(badge, height = context.px(64f), width = context.px(64f))
      gap(heading); gap(body); gap(versions)
      boxes.orientation = LinearLayout.HORIZONTAL
      boxes.addView(releasedBox, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      boxes.addView(leftBox, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(10f) })
      gap(boxes)
      gap(progress, height = context.px(6f)); gap(progressWords, 8f); gap(error)
      button.orientation = LinearLayout.HORIZONTAL
      button.gravity = Gravity.CENTER
      button.background = context.plate(Theme.accent, 16f)
      button.isClickable = true
      button.addView(buttonIcon, LinearLayout.LayoutParams(context.px(20f), context.px(20f)).apply { rightMargin = context.px(8f) })
      button.addView(buttonWords)
      button.setOnClickListener { pressed() }
      gap(button, height = context.px(50f))
      later.isClickable = true
      later.setOnClickListener { dismissUpdate() }
      gap(later, 6f, width = LinearLayout.LayoutParams.WRAP_CONTENT)
      val scroll = ScrollView(context).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
      val center = FrameLayout(context).apply { setPadding(context.px(24f), context.px(24f), context.px(24f), context.px(24f)) }
      center.addView(card, LayoutParams(minOf(context.px(420f), resources.displayMetrics.widthPixels - context.px(48f)), LayoutParams.WRAP_CONTENT, Gravity.CENTER))
      scroll.addView(center, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      refresh()
    }

    private fun box(context: Context, caption: String, tinted: Boolean): LinearLayout = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(context.px(6f), context.px(12f), context.px(6f), context.px(12f))
      background = context.plate(if (tinted) ThemeStore.look.accentSoft else Theme.surface2, 16f)
      addView(context.words(caption, 11f, if (tinted) Theme.accent else Theme.muted).apply { gravity = Gravity.CENTER })
      addView(context.words("", 15f, if (tinted) Theme.accent else Theme.text, 700).apply { gravity = Gravity.CENTER; maxLines = 1; tag = "value" }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f) })
    }

    private fun value(box: LinearLayout): TextView = box.findViewWithTag("value")

    private val automatic: Boolean get() = info?.android != null

    fun refresh() {
      setBackgroundColor(if (mandatory) Theme.bg else 0x8C000000.toInt())
      val info = info
      heading.text = if (mandatory) "Требуется обновление" else "Доступна новая версия"
      body.text = if (mandatory) "Эта версия Инвиза больше не поддерживается. Установи новую — переписка и аккаунт сохранятся."
        else "Вышло обновление Инвиза. Пока им можно пользоваться и без него, но после срока обновление станет обязательным. Переписка и аккаунт сохранятся."
      val asset = info?.android
      versions.text = info?.version?.let { "Новая версия $it" + (if (asset != null) " · " + FileCore.sizeText(asset.size) else "") + " · у тебя $appVersion" } ?: "У тебя $appVersion"
      val now = System.currentTimeMillis() + (info?.clockOffset ?: 0)
      val released = info?.releasedAt
      releasedBox.visibility = if (released != null) View.VISIBLE else View.GONE
      if (released != null) value(releasedBox).text = span(now - released) + " назад"
      val until = info?.requiredAt
      val left = if (until != null) until - now else null
      leftBox.visibility = if (!mandatory && left != null && left > 0) View.VISIBLE else View.GONE
      if (left != null && left > 0) value(leftBox).text = span(left)
      boxes.visibility = if (releasedBox.visibility == View.VISIBLE || leftBox.visibility == View.VISIBLE) View.VISIBLE else View.GONE
      val current = phase
      progress.visibility = if (current == null) View.GONE else View.VISIBLE
      progressWords.visibility = progress.visibility
      if (current != null) {
        progress.part = if (current.step == "install") 1f else current.progress
        progressWords.text = if (opened) "Подтверди установку в системном окне. Если Android попросит — разреши установку из Инвиза."
          else when (current.step) {
            "download" -> "Скачиваем… ${Math.round(current.progress * 100)}%"
            "verify" -> "Проверяем файл… ${Math.round(current.progress * 100)}%"
            else -> "Открываем установщик…"
          }
        progress.invalidate()
      }
      error.visibility = if (error.text.isNullOrEmpty()) View.GONE else View.VISIBLE
      val busy = current != null && !opened
      if (automatic) {
        button.visibility = View.VISIBLE
        buttonIcon.symbol = "download"
        buttonWords.text = if (opened) "Открыть установщик ещё раз" else "Установить"
      } else {
        button.visibility = if (pageAddress(info?.page) != null) View.VISIBLE else View.GONE
        buttonIcon.symbol = "arrow.up.right"
        buttonWords.text = "Открыть страницу загрузки"
      }
      buttonIcon.invalidate()
      button.isEnabled = !busy
      button.alpha = if (busy) 0.6f else 1f
      later.visibility = if (mandatory || busy) View.GONE else View.VISIBLE
    }

    private fun pressed() {
      val info = info ?: return
      val asset = info.android
      if (asset == null) {
        val address = pageAddress(info.page) ?: return
        try { context.startActivity(Intent(Intent.ACTION_VIEW, address).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { /* no browser */ }
        return
      }
      val version = info.version ?: return
      error.text = ""
      opened = false
      phase = Phase("download", 0f)
      refresh()
      install(context, asset, version, onPhase = { phase = it; refresh() }) { problem ->
        if (problem == null) opened = true else { phase = null; error.text = problem }
        refresh()
      }
    }

    /** Only an https address opens. */
    private fun pageAddress(text: String?): Uri? {
      val address = try { Uri.parse(text ?: return null) } catch (_: Exception) { return null }
      return if (address.scheme?.lowercase(Locale.ROOT) == "https" && !address.host.isNullOrEmpty()) address else null
    }

    /** The thin bar of how far the work has gone. */
    private class Progress(context: Context) : View(context) {
      var part = 0f
      private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      override fun onDraw(canvas: Canvas) {
        val r = height / 2f
        paint.color = Theme.surface2
        canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, paint)
        paint.color = Theme.accent
        canvas.drawRoundRect(0f, 0f, width * part.coerceIn(0f, 1f), height.toFloat(), r, r, paint)
      }
    }
  }
}
