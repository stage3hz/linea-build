package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.security.HistoryTransfer
import com.linea.messenger.security.LockBiometrics
import com.linea.messenger.security.LockStore
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Безопасность › «Переписки на новом устройстве» (docs/HISTORY-TRANSFER.md): how a copy from another own device goes,
 *  the encrypted backup («Ключ резервной копии», shown behind the app lock) and «Восстановить переписки». (The previous
 *  app: `mobile/src/HistorySection.tsx`; iOS: Settings/HistorySettings.swift.) Everything that touches keys is the
 *  core's (`history.*`). */
@SuppressLint("ViewConstructor")
class HistoryScreen(context: Context, private val messenger: Messenger) : SettingsPage(context, "Переписки на новом устройстве") {
  private var status: Map<*, *>? = null
  private var failure = ""
  private var notice = ""
  private var busy = false
  private val transferChanged: (Unit) -> Unit = { if (isAttachedToWindow) fill() }

  override fun build() {
    HistoryTransfer.changed.unwatch(transferChanged)
    HistoryTransfer.changed.watch(transferChanged)
    load()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    HistoryTransfer.changed.unwatch(transferChanged)
  }

  private fun load() {
    messenger.crypto.call("history.status") { result ->
      val value = result.getOrNull() as? Map<*, *>
      if (value != null) { status = value; failure = "" }
      else failure = CryptoService.failure(result)?.words?.ifEmpty { null } ?: "Не удалось узнать состояние резервной копии."
      fill()
    }
  }

  private fun card(parts: List<View>): View = SettingsLook.inset(stacked(context, parts, 13f), top = 16f, side = 16f, bottom = 16f)

  private fun fill() {
    clear()
    addGroup(rows = listOf(card(listOf(
      context.words("Сообщения зашифрованы только для устройств, которые были в аккаунте, когда их отправили. Новое устройство получает старые переписки двумя способами — оба со сквозным шифрованием, сервер их не читает.", 13f, Theme.muted),
    ))))
    if (HistoryTransfer.receiving) add(SettingsNotice(context, "Переносим переписки с другого устройства…"), 14f)
    else HistoryTransfer.waitingUntil?.let { add(SettingsNotice(context, "Переписки придут с другого твоего устройства после ${clock(it)} (через 10 минут после входа). Оно должно быть в сети с открытым приложением."), 14f) }
    if (HistoryTransfer.imported > 0) add(SettingsNotice(context, "Перенесено сообщений: ${HistoryTransfer.imported}."), 14f)
    addGroup("С другого своего устройства", listOf(card(listOf(
      context.words("При новом входе твои устройства покажут «Новый вход». Если в течение 10 минут его не завершить, любое из них в сети передаст переписки новому — зашифрованными только для него.", 13f, Theme.muted),
    ))))
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { load() }), 14f)
    if (notice.isNotEmpty()) add(SettingsNotice(context, notice), 14f)

    val warning = SettingsLook.inset(stacked(context, listOf(
      context.words("Ключ = доступ к копии", 12f, Theme.text, 700),
      context.words("Кто знает ключ резервной копии и может войти в твой аккаунт, тот может прочитать её. Храни ключ так же бережно, как пароль: не отправляй его в чатах и не фотографируй на чужие устройства.", 12f, Theme.muted),
    ), 5f), top = 13f, side = 13f, bottom = 13f)
    warning.background = android.graphics.drawable.GradientDrawable().apply { setColor(SettingsLook.chip); cornerRadius = context.px(14f).toFloat() }
    val parts = mutableListOf<View>(
      context.words("Зашифрованная копия переписок на сервере. Ключ создаётся на устройстве и на сервер не уходит; твои устройства передают его друг другу в зашифрованном виде.", 13f, Theme.muted),
      warning,
    )
    val state = status
    val enabled = state?.get("enabled") == true
    val held = state?.get("held") == true
    when {
      state == null -> parts.add(context.words("Загружаем…", 13f, Theme.muted))
      !enabled -> parts.add(SettingsButton(context, "Включить резервную копию", SettingsButton.Kind.SECONDARY, icon = "cloud-upload-outline").apply { onPress = { enable() } })
      held -> {
        parts.add(SettingsButton(context, "Ключ резервной копии", SettingsButton.Kind.SECONDARY, icon = "key-outline").apply { onPress = { showKey() } })
        parts.add(SettingsButton(context, "Выключить резервную копию", SettingsButton.Kind.DANGER, icon = "trash-outline").apply { onPress = { turnOff() } })
      }
      state["canRestore"] == true -> {
        parts.add(SettingsButton(context, "Восстановить переписки", icon = "cloud-download-outline").apply { onPress = { open(RestoreHistoryScreen(context, messenger)) } })
        parts.add(context.words("Понадобится ключ резервной копии: его можно открыть на другом твоём устройстве в Безопасность → «Переписки на новом устройстве» → «Ключ резервной копии».", 12f, Theme.muted))
      }
      else -> parts.add(context.words("Восстановить переписки можно после ${clock(state["restoreAt"] as? String)} — через 10 минут после входа.", 13f, Theme.muted))
    }
    addGroup("Резервная копия", listOf(card(parts)))
  }

  private fun enable() {
    if (busy) return
    busy = true
    messenger.crypto.call("history.enable") { result ->
      busy = false
      val secret = result.getOrNull() as? String
      if (secret != null) { open(BackupKeyScreen(context, secret)); HistoryTransfer.backup() }
      else failure = CryptoService.failure(result)?.words ?: "Не удалось включить резервную копию."
      load()
    }
  }

  private fun turnOff() {
    confirm("Выключить резервную копию?", "Копия и её ключ будут удалены с сервера. Переписки на твоих устройствах останутся. Если включить копию снова, будет создан новый ключ.", "Выключить") {
      messenger.crypto.call("history.disable") { result ->
        if (result.isFailure) failure = CryptoService.failure(result)?.words ?: "Не удалось выключить резервную копию." else notice = "Резервная копия удалена с сервера."
        load()
      }
    }
  }

  /** The key is shown only after the app lock (biometrics or the code) when the lock is on. */
  private fun showKey() {
    val reveal: () -> Unit = {
      messenger.crypto.call("history.secret") { result ->
        val secret = result.getOrNull() as? String
        if (secret != null) open(BackupKeyScreen(context, secret)) else { failure = "Ключ резервной копии недоступен на этом устройстве."; fill() }
      }
    }
    val settings = LockStore.current
    if (settings.record == null) return reveal()
    val askCode: () -> Unit = {
      val field = EditText(context).apply { inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD; typeface = Theme.weight(400) }
      ask(AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Код-пароль").setMessage("Чтобы показать ключ резервной копии").setView(field)
        .setNegativeButton("Отмена", null).setPositiveButton("Показать") { _, _ ->
          LockStore.check(field.text.toString()) { right -> if (right) reveal() else { failure = "Неверный код."; fill() } }
        })
    }
    val activity = context as? Activity
    if (settings.biometrics && activity != null) LockBiometrics.authenticate(activity, "Показать ключ резервной копии") { ok -> if (ok) reveal() else askCode() }
    else askCode()
  }

  companion object {
    fun clock(text: String?): String {
      val ms = HistoryTransfer.millis(text) ?: return ""
      return DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms))
    }
  }
}

/** The backup key as text in groups of 4 and as a QR code (both made by the core: `historyFormatSecret`, `historyQr`). */
@SuppressLint("ViewConstructor")
class BackupKeyScreen(context: Context, private val secret: String) : SettingsPage(context, "Ключ резервной копии") {
  override fun build() {
    val words = Core.view("historyFormatSecret", listOf(secret)) as? String ?: secret
    add(context.words(words, 21f, Theme.text, 700).apply {
      typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
      gravity = Gravity.CENTER
      setTextIsSelectable(true)
      contentDescription = "Ключ резервной копии: $words"
    }, 8f)
    val qrText = (Core.view("historySecretQr", listOf(secret)) as? String ?: "").uppercase()
    val rows = (Core.view("historyQr", listOf(qrText)) as? List<*>)?.filterIsInstance<String>()
    if (rows != null && rows.isNotEmpty()) {
      val side = context.px(240f)
      add(ImageView(context).apply {
        setImageBitmap(qr(rows, side))
        contentDescription = "QR-код ключа резервной копии"
        layoutParams = LinearLayout.LayoutParams(side, side).apply { gravity = Gravity.CENTER_HORIZONTAL }
      }, 18f)
    }
    add(SettingsLook.foot(context, "На новом устройстве открой Безопасность → «Переписки на новом устройстве» → «Восстановить переписки» и введи ключ или наведи камеру на этот код. Кто знает ключ и может войти в аккаунт, тот может прочитать копию."), 18f)
  }

  /** Black squares on white with a quiet border of 4 modules. */
  private fun qr(rows: List<String>, side: Int): Bitmap {
    val count = rows.size + 8
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.WHITE)
    val paint = Paint().apply { color = Color.BLACK; isAntiAlias = false }
    val cell = side.toFloat() / count
    rows.forEachIndexed { r, row -> row.forEachIndexed { c, dark -> if (dark == '1') canvas.drawRect((c + 4) * cell, (r + 4) * cell, (c + 5) * cell, (r + 5) * cell, paint) } }
    return bitmap
  }
}

/** «Восстановить переписки»: the key typed from the other phone. */
@SuppressLint("ViewConstructor")
class RestoreHistoryScreen(context: Context, private val messenger: Messenger) : SettingsPage(context, "Восстановить переписки") {
  private val field = SettingsField(context, "Ключ", "XXXX XXXX XXXX …")
  private val noticeBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
  private val restoreButton = SettingsButton(context, "Восстановить")
  private var busy = false

  override fun build() {
    add(SettingsLook.foot(context, "Введи ключ резервной копии с другого твоего устройства (9 групп по 4 символа) или отсканируй его QR-код. Попыток — 5 в час."), 4f)
    field.input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.onReturn = { restore() }
    add(field, 16f)
    add(noticeBox, 14f)
    restoreButton.onPress = { restore() }
    add(restoreButton, 14f)
    // The camera opens only after this tap, with the system's question if it was never asked.
    add(SettingsButton(context, "Сканировать QR-код", SettingsButton.Kind.SECONDARY, icon = "qr-code-outline").apply { onPress = { scan() } }, 10f)
  }

  private fun scan() {
    if (busy) return
    val activity = context as? Activity ?: return
    com.linea.messenger.voice.Permits.ask(activity, listOf(android.Manifest.permission.CAMERA)) { granted ->
      if (!granted) return@ask show("Нет доступа к камере. Введи ключ вручную или разреши камеру в настройках.", true)
      open(ScanKeyScreen(context) { text -> field.input.setText(text); restore() })
    }
  }

  private fun show(words: String, error: Boolean) {
    noticeBox.removeAllViews()
    noticeBox.addView(SettingsNotice(context, words, error = error))
  }

  private fun restore() {
    val typed = field.input.text.toString()
    if (busy || typed.isBlank()) return
    busy = true
    restoreButton.loading = true
    show("Восстанавливаем переписки…", false)
    messenger.crypto.call("history.restore", listOf(typed)) { result ->
      busy = false
      restoreButton.loading = false
      val count = (result.getOrNull() as? Number)?.toInt()
      if (count != null) {
        field.input.setText("")
        show("Переписки восстановлены. Сообщений: $count.", false)
        messenger.noteChanged(null)
      } else show(CryptoService.failure(result)?.words?.ifEmpty { null } ?: "Не удалось восстановить переписки.", true)
    }
  }
}

/** The back camera reading one QR code (ML Kit barcode scanning through Google Play services, on the phone: no frame
 *  leaves it). Goes back with the text as soon as one is read. */
@SuppressLint("ViewConstructor")
class ScanKeyScreen(context: Context, private val found: (String) -> Unit) : SettingsPage(context, "QR-код ключа") {
  // The picture in a TextureView (as the round video's single camera does): CameraX's PreviewView would bring media3
  // and guava along. The camera already turns the frames upright for a texture; only the aspect is corrected here.
  private val preview = android.view.TextureView(context)
  private var frame: android.util.Size? = null
  private val owner = object : androidx.lifecycle.LifecycleOwner {
    val registry = androidx.lifecycle.LifecycleRegistry(this)
    override fun getLifecycle(): androidx.lifecycle.Lifecycle = registry
  }
  private val scanner = com.google.mlkit.vision.barcode.BarcodeScanning.getClient(
    com.google.mlkit.vision.barcode.BarcodeScannerOptions.Builder().setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build())
  private val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
  private val delivered = java.util.concurrent.atomic.AtomicBoolean(false)
  private val noticeBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

  override fun build() {
    add(SettingsLook.foot(context, "Наведи камеру на QR-код ключа на другом твоём устройстве (Безопасность → «Переписки на новом устройстве» → «Ключ резервной копии»)."), 4f)
    add(preview.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.px(340f)) }, 14f)
    add(noticeBox, 14f)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    owner.registry.currentState = androidx.lifecycle.Lifecycle.State.RESUMED
    val future = try { androidx.camera.lifecycle.ProcessCameraProvider.getInstance(context) } catch (_: Throwable) { return fail() }
    future.addListener({
      if (!isAttachedToWindow) return@addListener
      try {
        val provider = future.get()
        val shown = androidx.camera.core.Preview.Builder().build()
        shown.setSurfaceProvider(context.mainExecutor) { request -> provide(request) }
        val analysis = androidx.camera.core.ImageAnalysis.Builder().setBackpressureStrategy(androidx.camera.core.ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(worker) { proxy -> analyze(proxy) }
        provider.unbindAll()
        provider.bindToLifecycle(owner, androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA, shown, analysis)
      } catch (_: Throwable) { fail() }
    }, context.mainExecutor)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    owner.registry.currentState = androidx.lifecycle.Lifecycle.State.DESTROYED
    scanner.close()
    worker.shutdown()
  }

  private fun provide(request: androidx.camera.core.SurfaceRequest) {
    val texture = preview.surfaceTexture
    if (texture == null) {
      // Not laid out yet: provide it once the texture is there.
      preview.surfaceTextureListener = object : android.view.TextureView.SurfaceTextureListener {
        override fun onSurfaceTextureAvailable(made: android.graphics.SurfaceTexture, width: Int, height: Int) = provide(request)
        override fun onSurfaceTextureSizeChanged(made: android.graphics.SurfaceTexture, width: Int, height: Int) = fit()
        override fun onSurfaceTextureDestroyed(made: android.graphics.SurfaceTexture): Boolean = true
        override fun onSurfaceTextureUpdated(made: android.graphics.SurfaceTexture) {}
      }
      return
    }
    texture.setDefaultBufferSize(request.resolution.width, request.resolution.height)
    frame = request.resolution
    val surface = android.view.Surface(texture)
    request.provideSurface(surface, context.mainExecutor) { surface.release() }
    fit()
  }

  /** The frame (landscape, shown turned upright) fills the view without being stretched. */
  private fun fit() {
    val size = frame ?: return
    val w = preview.width.toFloat()
    val h = preview.height.toFloat()
    if (w <= 0f || h <= 0f) return
    val (bw, bh) = size.height.toFloat() to size.width.toFloat()
    val scale = maxOf(w / bw, h / bh)
    preview.setTransform(android.graphics.Matrix().apply { setScale(bw * scale / w, bh * scale / h, w / 2f, h / 2f) })
  }

  private fun fail() {
    noticeBox.removeAllViews()
    noticeBox.addView(SettingsNotice(context, "Камера недоступна. Введи ключ вручную.", error = true))
  }

  @androidx.annotation.OptIn(markerClass = [androidx.camera.core.ExperimentalGetImage::class])
  private fun analyze(proxy: androidx.camera.core.ImageProxy) {
    val media = proxy.image
    if (media == null || delivered.get()) { proxy.close(); return }
    val input = com.google.mlkit.vision.common.InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
    scanner.process(input)
      .addOnSuccessListener { codes ->
        val text = codes.firstNotNullOfOrNull { it.rawValue } ?: return@addOnSuccessListener
        if (!delivered.compareAndSet(false, true)) return@addOnSuccessListener
        main.post { goBack(); found(text) }
      }
      .addOnCompleteListener { proxy.close() }
  }
}
