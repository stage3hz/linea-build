package com.linea.messenger.ai

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.ScrollView
import android.widget.TextView
import android.widget.VideoView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.Picks
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.shell.Screen
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

/** The «AI» section: one conversation with the free model behind the person's server. Ported from
 *  mobile/src/ai/AIScreen.tsx (iOS: AI/AIViewController.swift): the same steps, limits and words.
 *  With a `messenger`: the real section. Without: nothing can be asked (a debug build may show its samples). */
@SuppressLint("ViewConstructor")
class AIScreen(context: Context, private val messenger: Messenger?, private val quick: Boolean = false) : Screen(context) {
  private val history = AIHistory(messenger?.crypto)
  private val conversation: AIConversation
  private var status: AIStatus? = null
  private var statusError = ""
  private var checking = false
  private var conversationId = UUID.randomUUID().toString().lowercase()
  private var incognito = false
  private var chosenModel = "auto"
  private var models: List<String> = emptyList()
  private var taskError = ""
  private val details = HashSet<Int>()
  private var restored = false
  private var afterConsent: (() -> Unit)? = null
  private var audio: MediaPlayer? = null
  private var audioFile: File? = null
  private var focus: AudioFocusRequest? = null
  private var pendingView: AITurnView? = null
  private var started = false
  /** The copy of a made file another app was last given to read (see `share`). */
  private var shared: File? = null
  private val main = Handler(Looper.getMainLooper())
  private val clock = object : Runnable {
    override fun run() {
      pendingView?.tick()
      if (conversation.pending && isAttachedToWindow) main.postDelayed(this, 500)
    }
  }

  private val topBar = LinearLayout(context)
  private val historyButton = AIRoundButton(context, "menu", "История AI-бесед", icon = 21f)
  private val newButton = AIRoundButton(context, "compose", "Начать новую AI-беседу", icon = 21f)
  private val privateButton = AIRoundButton(context, "eye.slash", "Приватная беседа: не сохранять в историю", icon = 21f)
  private val scroll = ScrollView(context)
  private val list = LinearLayout(context)
  private val emptyBox = LinearLayout(context)
  private val composer = LinearLayout(context)
  private val input = EditText(context)
  private val toolsRow = LinearLayout(context)
  private val plusButton = AIRoundButton(context, "plus", "Режимы AI и вложения", size = 42f, icon = 24f)
  private val modelPill = TextView(context)
  private val sendButton = AIRoundButton(context, "arrow.up", "Отправить вопрос AI", size = 42f, icon = 21f)
  private val pendingRow = LinearLayout(context)
  // G: the reference's composer is one line while nothing is being written (AIScreen.tsx `expanded`): «+», the quiet
  // «Спроси что угодно» (a tap opens the field), the model, the send; the field and the tools row below it only once
  // the person writes, has a draft or attachments.
  private val collapsedWords = TextView(context)
  private val toolsSpacer = View(context)
  private var focused = false
  private val expanded: Boolean get() = focused || draft.isNotEmpty() || pictures.isNotEmpty() || documents.isNotEmpty() || reading > 0
  /** AI: photos (video frames) and documents attached to the next question (ai/attach.ts; ai/AIAttachments.kt). Pictures
   *  go with one question; documents stay with the whole conversation. `quick`: the quick dialog (`AIQuickDialog`) — over
   *  another screen, no history, «Закрыть» instead of the history. */
  private var pictures: List<AIPicture> = emptyList()
  private var documents: List<AIDocumentText> = emptyList()
  private var reading = 0
  private val attachStrip = AIAttachmentStrip(context)

  // State

  private val router: Boolean get() = status?.router == true
  /** Without Platina: fast text answers only. */
  private val full: Boolean get() = status?.platina != false
  private val ready: Boolean get() = status?.configured == true && status?.can("text") == true
  private val draft: String get() = input.text.toString()

  init {
    setBackgroundColor(Theme.bg)
    AIMediaCache.folder = context.cacheDir
    build()
    val server = messenger?.server
    conversation = AIConversation({ messages, model, images, documents, done ->
      if (server == null) done(Result.failure(AIFailure("Нужно войти в аккаунт."))) else AIClient.chat(server, messages, model, images, documents, done)
    })
    if (quick) conversationId = "quick-$conversationId"
    conversation.discardMedia = { media -> AIMediaCache.delete(listOf(media.uri)) }
    conversation.onChange = { changed() }
    history.onChange = { historyChanged() }
    render()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!started) {
      started = true
      // A debug build's look without an account: a sample conversation, no server.
      // The quick dialog has no history.
      if (messenger == null && AIDemo.mode != null) demo() else { if (!quick) history.load(); refreshStatus() }
    }
    if (conversation.pending) { main.removeCallbacks(clock); main.post(clock) }
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacks(clock)
    stopAudio()
    super.onDetachedFromWindow()
  }

  private fun refreshStatus() {
    val server = messenger?.server ?: return render()
    status = null
    statusError = ""
    checking = true
    render()
    AIClient.status(server) { result ->
      checking = false
      val value = result.getOrNull()
      if (value != null) {
        status = value
        if (value.router && value.can("models")) AIClient.models(server) { found -> models = found; render() }
      } else {
        statusError = (result.exceptionOrNull() as? AIFailure)?.words.orEmpty().ifEmpty { "Не удалось проверить доступность AI." }
      }
      render()
    }
  }

  private fun historyChanged() {
    // Reopen the latest conversation once the encrypted history has loaded.
    if (restored || !history.loaded) return
    restored = true
    val latest = history.items.firstOrNull() ?: return
    if (conversation.turns.isNotEmpty()) return
    conversationId = latest.id
    reopen(latest.turns, latest.consent)
  }

  private fun reopen(turns: List<AITurn>, consent: Boolean) {
    conversation.restore(turns, consent)
    conversation.dropMedia(AIMediaCache.missing(conversation.turns))
  }

  private fun changed() {
    if (!quick && !incognito && !conversation.pending && conversation.turns.isNotEmpty() && messenger != null) {
      history.save(conversationId, conversation.turns, conversation.consent)
    }
    if (!quick && history.loaded && !conversation.pending && messenger != null) {
      val open = AIMediaCache.names(conversation.turns)
      val stored = history.items.flatMap { AIMediaCache.names(it.turns) }
      Thread({ AIMediaCache.prune(stored + open, open) }, "invizent.ai.cache").apply { isDaemon = true }.start()
    }
    render()
    if (conversation.pending || conversation.turns.lastOrNull()?.status == "complete") scroll.post { scrollToEnd() }
  }

  private fun scrollToEnd() {
    val bottom = list.height + scroll.paddingTop + scroll.paddingBottom - scroll.height
    if (bottom > 0) scroll.smoothScrollTo(0, bottom)
  }

  // Sending

  private fun submit() {
    if (draft.isBlank() || !ready || conversation.pending) return
    if (!conversation.consent) {
      afterConsent = { send() }
      showConsent()
      return
    }
    send()
  }

  private fun askModel(): String? = if (full && router && chosenModel != "auto") chosenModel else null

  // The photos went with this question (setPhoto(null)).
  private fun sent() { if (conversation.pending) { input.setText(""); pictures = emptyList(); render() } }

  private val vision: Boolean get() = status?.can("vision") == true
  private val docs: Boolean get() = status?.can("documents") == true
  /** What goes with a text question (`askOptions`): pictures and documents when the server takes them, with Platina. */
  private val askImages: List<String> get() = if (full && vision) pictures.map { it.data } else emptyList()
  private val askDocuments: List<AIDocumentText> get() = if (full && docs) documents else emptyList()

  private fun cached(owner: String, data: ByteArray, mimeType: String, made: (AIMedia) -> AITaskResult): Result<AITaskResult> =
    try { Result.success(made(AIMedia(AIMediaCache.write(owner, data, mimeType), mimeType))) } catch (failure: AIFailure) { Result.failure(failure) }

  private fun send() {
    val server = messenger?.server
    if (!ready || server == null) return
    val question = draft.trim()
    val photo = pictures.firstOrNull()?.data?.takeIf { it.isNotEmpty() }
    val intent = AIModel.detectIntent(question, hasPhoto = photo != null)
    if (intent == "text") {
      taskError = ""
      conversation.ask(question, askModel(), askImages, askDocuments)
      return sent()
    }
    val label = if (intent == "image") "Картинки" else if (intent == "video") "Видео" else "Озвучка"
    if (!full) return showPlatina(label)
    if (!router || status?.can(intent) != true) {
      taskError = "$label пока не подключены на сервере — отвечу текстом."
      conversation.ask(question, askModel(), askImages, askDocuments)
      return sent()
    }
    val owner = conversationId
    val work: AIWork = when (intent) {
      "image" -> image@{ stage, done ->
        val draw: (String) -> Unit = { prompt ->
          stage("Рисую картинку")
          AIClient.image(server, prompt) { result ->
            val made = result.getOrNull()
            val words = if (photo != null) "Новая картинка по мотивам твоего фото (провайдер рисует заново по описанию, само фото не меняется). Нажми на картинку, чтобы сохранить или отправить." else "Готово. Нажми на картинку, чтобы сохранить или отправить."
            if (made == null) done(Result.failure(result.exceptionOrNull()!!))
            else done(cached(owner, made.data, made.mimeType) { AITaskResult(words, made.routedVia ?: "генерация картинок", made.routedVia, it) })
          }
        }
        if (photo == null) return@image draw(question)
        // The provider draws from text, so the photo is first described (vision) together with the request.
        stage("Смотрю на твоё фото")
        val ask = "Опиши это изображение для генератора картинок: что на нём, цвета, композиция, стиль. Учти просьбу пользователя и выдай один итоговый промпт на английском до 900 символов, без пояснений.\n\nПросьба: $question"
        AIClient.chat(server, listOf(mapOf("role" to "user", "content" to ask)), null, listOf(photo)) { result ->
          val reply = result.getOrNull()
          if (reply == null) done(Result.failure(result.exceptionOrNull()!!)) else draw(reply.text.take(3900))
        }
      }
      "video" -> { _, done ->
        AIClient.video(server, question, 5) { result ->
          val bytes = result.getOrNull()
          if (bytes == null) done(Result.failure(result.exceptionOrNull()!!))
          else done(cached(owner, bytes, "video/mp4") { AITaskResult("Видео готово.", "генерация видео", null, it) })
        }
      }
      else -> work@{ _, done ->
        val spoken = AIModel.speechText(question)
        if (spoken.isEmpty()) return@work done(Result.failure(AIFailure("Напиши после «озвучь», что именно сказать.")))
        AIClient.speech(server, spoken, "nova") { result ->
          val made = result.getOrNull()
          if (made == null) done(Result.failure(result.exceptionOrNull()!!))
          else done(cached(owner, made.data, made.mimeType) { AITaskResult(spoken, "озвучка", null, it) })
        }
      }
    }
    taskError = ""
    conversation.askTask(question, intent, work)
    sent()
  }

  private fun newConversation() {
    AIMediaCache.delete(AIMediaCache.names(conversation.turns.filter { it.isPrivate || quick }))
    documents = emptyList()
    pictures = emptyList()
    stopAudio()
    conversation.clear()
    conversationId = UUID.randomUUID().toString().lowercase()
    input.setText("")
    taskError = ""
    details.clear()
    render()
  }

  private fun togglePrivate() {
    incognito = !incognito
    conversation.privateTurns = incognito
    render()
  }

  // Audio file → text

  private fun transcribeFile() {
    if (!ready) return
    if (!conversation.consent) {
      afterConsent = { transcribeFile() }
      showConsent()
      return
    }
    val activity = context as? Activity ?: return
    // The system's own chooser: the app is handed the one file the person picked, and asks no permission.
    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*")
    Picks.ask(activity, pick) { uris -> uris.firstOrNull()?.let { picked(it) } }
  }

  private class Picked(val name: String, val bytes: ByteArray?, val tooBig: Boolean)

  private fun picked(uri: Uri) {
    val server = messenger?.server ?: return
    val resolver = context.contentResolver
    Thread({
      val limit = 10 * 1024 * 1024
      var name = "аудио"
      var tooBig = false
      var bytes: ByteArray? = null
      try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotEmpty() }?.let { name = it.take(150) }
        }
        resolver.openInputStream(uri)?.use { stream ->
          val out = ByteArrayOutputStream()
          val chunk = ByteArray(64 * 1024)
          while (true) {
            val got = stream.read(chunk)
            if (got < 0) break
            if (out.size() + got > limit) { tooBig = true; break }
            out.write(chunk, 0, got)
          }
          if (!tooBig && out.size() > 0) bytes = out.toByteArray()
        }
      } catch (_: Exception) { bytes = null }
      val read = Picked(name, bytes, tooBig)
      main.post {
        val audio = read.bytes
        if (audio == null) {
          taskError = if (read.tooBig) "Аудио для расшифровки — до 10 МБ." else "Не удалось открыть аудио."
          return@post render()
        }
        taskError = ""
        conversation.askTask("Расшифруй аудио «${read.name}»", "transcribe") { _, done ->
          AIClient.transcribe(server, audio) { result ->
            val text = result.getOrNull()
            done(if (text == null) Result.failure(result.exceptionOrNull()!!) else Result.success(AITaskResult(text, "расшифровка аудио")))
          }
        }
      }
    }, "invizent.ai.pick").apply { isDaemon = true }.start()
  }

  // Sheets

  private fun showConsent() {
    val sheet = AISheet(context, "Отправить вопрос AI?")
    val via = if (status?.provider == "freellmapi") "в сервис FreeLLMAPI и бесплатному поставщику модели, которого он выберет" else "в OpenRouter и поставщику модели"
    sheet.addText("Вопросы и история этой беседы передаются через твой сервер $via. В AI попадает только то, что ты пишешь и прикладываешь здесь: текст, фото и кадры видео (без геометки и других данных EXIF) и текст приложенных документов. Разрешение действует только для этой беседы.", 12f)
    sheet.addText(if (incognito) "Это приватная беседа: на устройстве она не сохранится." else "История бесед хранится зашифрованной только на этом устройстве.", 12f)
    if (status?.provider != "freellmapi") {
      val link = AIKit.label(context, "Конфиденциальность OpenRouter", 12f, color = Theme.accent)
      link.isClickable = true
      link.isFocusable = true
      link.minHeight = dp(32f)
      link.gravity = Gravity.CENTER_VERTICAL
      link.setOnClickListener { openLink("https://openrouter.ai/privacy") }
      sheet.add(link, wide = false)
    }
    val allow = AIWideButton(context, "Разрешить и отправить", "arrow.up")
    allow.setOnClickListener {
      conversation.setConsent(true)
      sheet.dismiss()
    }
    sheet.add(allow)
    val cancel = AIWideButton(context, "Отмена", secondary = true)
    cancel.setOnClickListener {
      afterConsent = null
      sheet.dismiss()
    }
    sheet.add(cancel)
    sheet.onClosed = {
      val following = afterConsent
      afterConsent = null
      // Closed without an answer: nothing is sent.
      if (conversation.consent) following?.invoke()
    }
    sheet.open()
  }

  private fun showPlatina(what: String) {
    val sheet = AISheet(context, "$what — с Platina")
    sheet.addText("Доступно только с подпиской Инвиз Platina", 15f, 600, Theme.text)
    sheet.addText("Без Platina AI отвечает на текстовые вопросы быстрой моделью. С Platina — выбор моделей, код, вопросы по фото, картинки, видео, озвучка и расшифровка аудио.")
    sheet.open()
  }

  /** The list of kept conversations (also what `--es aidemo history` asks for). */
  fun showHistory() {
    val sheet = AISheet(context, "История AI")
    if (history.items.isEmpty()) sheet.addText("Пока нет сохранённых бесед.")
    val now = Instant.now(); val zone = ZoneId.systemDefault()
    for (item in history.items) {
      val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
      val count = item.turns.size
      val open = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(10f), dp(12f), dp(10f), dp(12f))
        if (item.id == conversationId) background = context.plate(Theme.veil(0.1f), 16f)
        isClickable = true
        isFocusable = true
      }
      open.addView(AIKit.label(context, item.title, 14f, 600, lines = 1))
      AIKit.add(open, AIKit.label(context, "${AIModel.listTime(AIModel.updated(item), now, zone)} · $count ${AIModel.questionsNoun(count)}", 11f, color = Theme.muted, lines = 1), 4f)
      open.setOnClickListener {
        stopAudio()
        reopen(item.turns, item.consent)
        conversationId = item.id
        input.setText("")
        taskError = ""
        render()
        sheet.dismiss()
      }
      row.addView(open, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      val trash = AIIconButton(context, "trash", 19f, Theme.danger, "Удалить беседу ${item.title}")
      trash.setOnClickListener {
        history.remove(item.id)
        AIMediaCache.delete(AIMediaCache.names(item.turns))
        if (item.id == conversationId) newConversation()
        (row.parent as? ViewGroup)?.removeView(row)
      }
      row.addView(trash, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { marginStart = dp(6f) })
      sheet.add(row, 6f)
    }
    sheet.open()
  }

  // Menus

  /** Model choice: the strategies with a line about each, «Другие модели» with what the server has right now.
   *  Without the FreeLLMAPI router there is one free model; without Platina the other entries are locked. */
  private fun showModels() {
    val value = if (router && full) chosenModel else "auto"
    val locked = router && !full
    val sheet = AISheet(context, "")
    fun row(id: String, label: String, help: String?, lockedRow: Boolean) {
      sheet.addRow(label, help, if (lockedRow) "lock" else null, checked = value == id) {
        sheet.dismiss()
        if (lockedRow) return@addRow showPlatina("Выбор модели")
        chosenModel = id
        render()
      }
    }
    if (router) for ((id, help) in AIModel.strategies) row(id, AIModel.modelLabel(id), help, locked && id != value)
    else row("auto", "Авто", "Бесплатная модель, которую подбирает сервер", false)
    val known = AIModel.strategies.map { it.first }.toSet()
    val more = models.filter { it !in known }
    if (router && more.isNotEmpty()) {
      if (locked) {
        sheet.addRow("Другие модели", symbol = "lock") { sheet.dismiss(); showPlatina("Выбор модели") }
      } else {
        sheet.addText("Другие модели", 12f, 600)
        for (id in more) row(id, AIModel.modelLabel(id), id.split('/').takeIf { it.size > 1 }?.first(), false)
      }
    }
    val note = if (!router) "Выбор моделей появится, когда на сервере подключат FreeLLMAPI." else if (!full) "Выбор модели — с Инвиз Platina." else ""
    if (note.isNotEmpty()) sheet.addText(note, 11f)
    sheet.open()
  }

  private fun showTools() {
    val sheet = AISheet(context, "Вложения")
    sheet.addText("Всё в одном чате: приложи фото, видео или документ и спроси о них. Попроси «нарисуй…» — AI нарисует, «сделай из этого аниме» с фото — перерисует.", 12f)
    // «Фото и видео» and «Документ» (with Platina; when the server allows them).
    sheet.addRow("Фото и видео", symbol = if (full) "photo" else "lock", enabled = vision) {
      sheet.dismiss()
      if (!full) showPlatina("Фото и видео") else pickPictures()
    }
    sheet.addRow("Документ", symbol = if (full) "doc" else "lock", enabled = docs) {
      sheet.dismiss()
      if (!full) showPlatina("Документ") else pickDocuments()
    }
    val canTranscribe = router && status?.can("transcribe") == true
    sheet.addRow("Аудиофайл → текст", symbol = if (full) "mic" else "lock", enabled = canTranscribe) {
      sheet.dismiss()
      if (!full) showPlatina("Аудиофайл → текст") else transcribeFile()
    }
    sheet.open()
  }

  // Media of an answer

  private fun openLink(address: String) {
    try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))) } catch (_: Exception) { /* no app shows links */ }
  }

  /** Hands a made file to the app the person chooses (`AIShare`). */
  private fun share(file: File) {
    shared = AIShare.send(context, file, shared)
    if (shared == null) {
      taskError = "Не удалось открыть файл."
      render()
    }
  }

  private fun stopAudio() {
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    focus?.let { manager?.abandonAudioFocusRequest(it) }
    focus = null
    audio?.let { player -> try { player.stop() } catch (_: Exception) {}; player.release() }
    val had = audio != null
    audio = null
    audioFile = null
    if (had && isAttachedToWindow) render()
  }

  private fun play(file: File) {
    val current = audio
    if (audioFile == file && current != null) {
      try { if (current.isPlaying) current.pause() else current.start() } catch (_: Exception) { stopAudio() }
      return render()
    }
    stopAudio()
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    val player = MediaPlayer()
    try {
      player.setAudioAttributes(attributes)
      player.setDataSource(file.path)
      player.prepare()
    } catch (_: Exception) {
      player.release()
      taskError = "Не удалось воспроизвести аудио. Проверь соединение или выбери другой файл."
      return render()
    }
    // Whatever else is playing steps aside for the length of the speech (the app's own music too).
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
      .setOnAudioFocusChangeListener({ change -> if (change < 0) main.post { stopAudio() } }, main).build()
    (context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.requestAudioFocus(request)
    focus = request
    player.setOnCompletionListener { stopAudio() }
    player.setOnErrorListener { _, _, _ -> stopAudio(); true }
    audio = player
    audioFile = file
    player.start()
    render()
  }

  /** A made video, played over the page; Back closes it. */
  private fun watch(file: File) {
    stopAudio()
    val dialog = Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
    val video = VideoView(context)
    val box = FrameLayout(context).apply { setBackgroundColor(0xFF000000.toInt()) }
    box.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    dialog.setContentView(box)
    video.setMediaController(MediaController(context).apply { setAnchorView(box) })
    video.setVideoPath(file.path)
    video.setOnPreparedListener { video.start() }
    video.setOnErrorListener { _, _, _ ->
      dialog.dismiss()
      taskError = "Не удалось воспроизвести видео."
      render()
      true
    }
    dialog.setOnDismissListener { try { video.stopPlayback() } catch (_: Exception) {} }
    try { dialog.show() } catch (_: Exception) { /* the window is gone */ }
  }

  // The page

  private fun build() {
    val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    topBar.orientation = LinearLayout.HORIZONTAL
    topBar.gravity = Gravity.CENTER_VERTICAL
    topBar.addView(historyButton, LinearLayout.LayoutParams(dp(48f), dp(48f)))
    topBar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    topBar.addView(newButton, LinearLayout.LayoutParams(dp(48f), dp(48f)))
    topBar.addView(privateButton, LinearLayout.LayoutParams(dp(48f), dp(48f)).apply { marginStart = dp(10f) })
    if (quick) {
      // `AIQuickDialog`: «Закрыть» in place of the history.
      historyButton.symbol = "xmark"
      historyButton.contentDescription = "Закрыть быстрый вопрос AI"
      historyButton.setOnClickListener { closeQuick() }
    } else historyButton.setOnClickListener { showHistory() }
    newButton.setOnClickListener { newConversation() }
    privateButton.setOnClickListener { togglePrivate() }

    scroll.isVerticalScrollBarEnabled = false
    scroll.clipToPadding = false
    scroll.setPadding(dp(16f), dp(8f), dp(16f), dp(20f))
    list.orientation = LinearLayout.VERTICAL
    scroll.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    addView(scroll)
    addView(topBar)

    emptyBox.orientation = LinearLayout.VERTICAL
    emptyBox.gravity = Gravity.CENTER_HORIZONTAL
    addView(emptyBox)

    composer.orientation = LinearLayout.VERTICAL
    composer.background = context.plate(Theme.raised(0xF52E2E30.toInt()), 30f, Theme.veil(0.1f))
    composer.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
    input.hint = "Спроси что угодно"
    input.setHintTextColor(Theme.muted)
    input.setTextColor(Theme.text)
    input.textSize = 17f
    input.background = null
    input.setPadding(dp(11f), dp(10f), dp(11f), dp(6f))
    input.minHeight = dp(44f)
    input.maxHeight = dp(160f)
    input.gravity = Gravity.TOP or Gravity.START
    input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    input.filters = arrayOf(InputFilter.LengthFilter(AILimits.message))
    input.contentDescription = "Вопрос AI"
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) { paintSend(); applyExpanded() }
    })
    input.setOnFocusChangeListener { _, has -> focused = has; applyExpanded() }
    attachStrip.onRemovePicture = { id -> pictures = pictures.filter { it.id != id }; render() }
    attachStrip.onRemoveDocument = { name -> documents = documents.filter { it.name != name }; render() }
    composer.addView(attachStrip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(62f)))
    composer.addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, wrap))

    toolsRow.orientation = LinearLayout.HORIZONTAL
    toolsRow.gravity = Gravity.CENTER_VERTICAL
    plusButton.bordered = false
    plusButton.setOnClickListener { showTools() }
    modelPill.textSize = 14f
    modelPill.typeface = Theme.weight(500)
    modelPill.setTextColor(Theme.text)
    modelPill.maxLines = 1
    modelPill.ellipsize = android.text.TextUtils.TruncateAt.END
    modelPill.gravity = Gravity.CENTER_VERTICAL
    modelPill.setPadding(dp(12f), 0, dp(12f), 0)
    modelPill.isClickable = true
    modelPill.isFocusable = true
    modelPill.setOnClickListener { showModels() }
    sendButton.bordered = false
    sendButton.setOnClickListener { submit() }
    collapsedWords.text = "Спроси что угодно"
    collapsedWords.textSize = 17f
    collapsedWords.typeface = Theme.weight(400)
    collapsedWords.setTextColor(Theme.muted)
    collapsedWords.maxLines = 1
    collapsedWords.ellipsize = android.text.TextUtils.TruncateAt.END
    collapsedWords.gravity = Gravity.CENTER_VERTICAL
    collapsedWords.setPadding(dp(6f), 0, dp(6f), 0)
    collapsedWords.isClickable = true
    collapsedWords.isFocusable = true
    collapsedWords.contentDescription = "Написать вопрос AI"
    collapsedWords.setOnClickListener {
      focused = true
      applyExpanded()
      input.requestFocus()
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.showSoftInput(input, 0)
    }
    toolsRow.addView(plusButton, LinearLayout.LayoutParams(dp(42f), dp(42f)))
    toolsRow.addView(collapsedWords, LinearLayout.LayoutParams(0, dp(42f), 1f).apply { marginStart = dp(8f) })
    toolsRow.addView(modelPill, LinearLayout.LayoutParams(wrap, dp(42f)).apply { marginStart = dp(8f) })
    toolsRow.addView(toolsSpacer, LinearLayout.LayoutParams(0, 1, 1f))
    toolsRow.addView(sendButton, LinearLayout.LayoutParams(dp(42f), dp(42f)).apply { marginStart = dp(8f) })
    composer.addView(toolsRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, wrap).apply { topMargin = dp(6f) })

    pendingRow.orientation = LinearLayout.HORIZONTAL
    pendingRow.gravity = Gravity.CENTER_VERTICAL
    pendingRow.setPadding(dp(6f), dp(4f), dp(4f), dp(4f))
    val stopButton = AIRoundButton(context, "stop", "Отменить ожидание", active = true, size = 42f, icon = 18f)
    stopButton.fill = Theme.text
    stopButton.ink = Theme.onAccent
    stopButton.setOnClickListener { conversation.cancel() }
    pendingRow.addView(AIKit.spinner(context), LinearLayout.LayoutParams(dp(20f), dp(20f)))
    pendingRow.addView(AIKit.label(context, "AI думает…", 13f, color = Theme.muted, lines = 1), LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(10f) })
    pendingRow.addView(stopButton, LinearLayout.LayoutParams(dp(42f), dp(42f)))
    composer.addView(pendingRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, wrap))
    addView(composer)
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top + dp(10f)
    put(topBar, dp(16f), top, width - dp(32f), dp(48f))
    // The section sits under the shell's bar: the composer stays above it — or above the keyboard when it is up.
    val floor = if (edges.keyboard > 0) height - edges.keyboard - dp(8f) else height - dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 10f)
    val composerWidth = width - dp(28f)
    composer.measure(MeasureSpec.makeMeasureSpec(composerWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val composerTop = floor - composer.measuredHeight
    composer.layout(dp(14f), composerTop, dp(14f) + composerWidth, floor)
    val scrollTop = top + dp(48f) + dp(4f)
    put(scroll, 0, scrollTop, width, composerTop - dp(3f) - scrollTop)
    emptyBox.measure(MeasureSpec.makeMeasureSpec(width - dp(72f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val emptyTop = scrollTop + maxOf(0, (composerTop - scrollTop - emptyBox.measuredHeight) / 2)
    emptyBox.layout(dp(36f), emptyTop, width - dp(36f), emptyTop + emptyBox.measuredHeight)
  }

  private fun paintSend() {
    val can = draft.isNotBlank() && ready
    sendButton.isEnabled = can
    sendButton.fill = if (can) Theme.text else Theme.surface2
    sendButton.ink = if (can) Theme.onAccent else Theme.muted
  }

  /** G: one line, or the field over the tools row. */
  private fun applyExpanded() {
    val open = expanded
    input.visibility = if (conversation.pending || !open) View.GONE else View.VISIBLE
    collapsedWords.visibility = if (open) View.GONE else View.VISIBLE
    toolsSpacer.visibility = if (open) View.VISIBLE else View.GONE
  }

  /** G: the reference's `Button secondary` — a wide glass button (GlassSurface «regular», radius 21, 54 tall), the
   *  icon (20) 10 before the bold words (16); it springs to 0.96 under the finger; it stretches across the empty page. */
  private fun retryButton(): View = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
    setPadding(dp(21f), 0, dp(21f), 0)
    minimumHeight = dp(54f)
    addView(AIIconView(context, "refresh", 18f, Theme.text), LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginEnd = dp(10f) })
    addView(AIKit.label(context, "Проверить снова", 16f, 700, lines = 1))
    isClickable = true
    isFocusable = true
    contentDescription = "Проверить снова"
    com.linea.messenger.design.GlassBacking.put(this, 0.96f, 21f * d, clear = false)
    setOnClickListener { refreshStatus() }
  }

  private fun render() {
    val turns = conversation.turns
    newButton.visibility = if (turns.isEmpty()) View.GONE else View.VISIBLE
    privateButton.active = incognito
    privateButton.contentDescription = if (incognito) "Приватная беседа включена: не сохраняется" else "Приватная беседа: не сохранять в историю"

    // The middle of an empty page: checking, an error, «not connected», or the greeting.
    emptyBox.removeAllViews()
    val empty = turns.isEmpty()
    val centre = Gravity.CENTER_HORIZONTAL
    if (checking) {
      emptyBox.addView(AIKit.spinner(context), LinearLayout.LayoutParams(dp(24f), dp(24f)))
      AIKit.add(emptyBox, AIKit.label(context, "Проверяем доступность AI…", 12f, color = Theme.muted, align = centre), 14f)
    } else if (statusError.isNotEmpty()) {
      emptyBox.addView(AIKit.label(context, statusError, 13f, color = Theme.danger, align = centre))
      AIKit.add(emptyBox, retryButton(), 14f)
    } else if (!ready && empty) {
      emptyBox.addView(AIIconView(context, "sparkles", 34f, Theme.muted), LinearLayout.LayoutParams(dp(40f), dp(40f)))
      AIKit.add(emptyBox, AIKit.label(context, "AI пока не подключён на этом сервере", 18f, 700, align = centre), 14f)
      AIKit.add(emptyBox, AIKit.label(context, "Когда администратор подключит сервис, здесь можно будет задать вопрос.", 12f, color = Theme.muted, align = centre), 14f)
      AIKit.add(emptyBox, retryButton(), 14f)
    } else if (empty) {
      emptyBox.addView(AIIconView(context, "ion:sparkles", 40f, Theme.accent), LinearLayout.LayoutParams(dp(46f), dp(46f)))
      val greeting = AIModel.greeting(LocalTime.now().hour, messenger?.user?.get("displayName") as? String ?: "")
      AIKit.add(emptyBox, AIKit.label(context, greeting, 28f, 500, align = centre), 14f)
      if (incognito) AIKit.add(emptyBox, AIKit.label(context, "Приватная беседа: она не сохранится в истории.", 12f, color = Theme.muted, align = centre), 14f)
    }
    emptyBox.visibility = if (empty || checking || statusError.isNotEmpty()) View.VISIBLE else View.GONE

    list.removeAllViews()
    pendingView = null
    val canRetry = ready && conversation.consent && !conversation.pending
    for (turn in turns) {
      val file = turn.media?.let { AIMediaCache.file(it.uri) }
      val playing = file != null && file == audioFile && (try { audio?.isPlaying == true } catch (_: Exception) { false })
      val row = AITurnView(context, turn, retryable = turn.id == turns.lastOrNull()?.id, canRetry = canRetry, router = router, details = turn.id in details, playing = playing)
      val id = turn.id
      row.onRetry = { conversation.retry() }
      row.onDetails = {
        if (!details.remove(id)) details.add(id)
        render()
      }
      row.onShare = { share(it) }
      row.onPlay = { play(it) }
      row.onVideo = { watch(it) }
      if (turn.status == "pending") pendingView = row
      AIKit.add(list, row, 13f)
    }
    if (conversation.error.isNotEmpty() && conversation.error != turns.lastOrNull()?.error) AIKit.add(list, AIKit.notice(context, conversation.error, error = true), 13f)
    if (taskError.isNotEmpty()) AIKit.add(list, AIKit.notice(context, taskError, error = true), 13f)

    val pending = conversation.pending
    applyExpanded()
    toolsRow.visibility = if (pending) View.GONE else View.VISIBLE
    pendingRow.visibility = if (pending) View.VISIBLE else View.GONE
    attachStrip.show(pictures, documents, reading)
    attachStrip.visibility = if (attachStrip.empty || pending) View.GONE else View.VISIBLE
    modelPill.visibility = if (ready) View.VISIBLE else View.GONE
    val value = if (router && full) chosenModel else "auto"
    modelPill.text = AIModel.modelLabel(value) + " ⌄"
    modelPill.contentDescription = "Модель AI: ${AIModel.modelLabel(value)}. Выбрать другую"
    paintSend()

    main.removeCallbacks(clock)
    if (pending && isAttachedToWindow) main.postDelayed(clock, 500)
    requestLayout()
  }

  // AI: attachments and the quick dialog

  private fun closeQuick() { pages()?.let { if (it.top === this) it.pop() } }

  /** Opens the quick dialog over the screen (`AIQuickDialog`): its own conversation, no history. */
  fun openQuick() { pages()?.push(AIScreen(context, messenger, quick = true).also { if (messenger == null) it.status = status }) }

  private fun pages(): com.linea.messenger.shell.Navigation? {
    var above = parent
    while (above != null && above !is com.linea.messenger.shell.Navigation) above = above.parent
    return above as? com.linea.messenger.shell.Navigation
  }

  private fun pickPictures() {
    val room = AIAttach.MAX_PICTURES - pictures.size
    if (room <= 0) { taskError = "К вопросу — до ${AIAttach.MAX_PICTURES} фото и кадров."; return render() }
    val activity = context as? Activity ?: return
    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
      .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*")).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    Picks.ask(activity, pick) { uris -> takePictures(uris.take(room)) }
  }

  /** Photos and videos made into small clean pictures, off the main thread. */
  private fun takePictures(uris: List<Uri>) {
    val app = context.applicationContext
    Thread({
      val made = ArrayList<AIPicture>()
      var problem = ""
      for ((index, uri) in uris.withIndex()) {
        val (name, type) = AIAttach.describe(app, uri)
        val video = type.startsWith("video/")
        val images = if (video) AIAttach.frames(app, uri) else listOfNotNull(AIAttach.photo(app, uri))
        if (images.isEmpty()) problem = if (video) AIAttach.MEDIA_AS_DOCUMENT else "Не удалось подготовить фото."
        for ((frame, image) in images.withIndex()) {
          try { val (data, preview) = AIAttach.jpeg(image); made.add(AIPicture("$name#$index-$frame", preview, data, video)) }
          catch (failure: AIFailure) { problem = failure.words }
        }
      }
      main.post {
        pictures = (pictures + made).take(AIAttach.MAX_PICTURES)
        taskError = problem
        render()
      }
    }, "invizent.ai.pictures").apply { isDaemon = true }.start()
  }

  private fun pickDocuments() {
    val activity = context as? Activity ?: return
    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    Picks.ask(activity, pick) { uris -> tookDocuments(uris) }
  }

  /** Files chosen as «Документ»: a photo or a video in them is prepared like «Фото и видео» does (never sent as it is);
   *  everything else is read into text by the server. */
  private fun tookDocuments(uris: List<Uri>) {
    val server = messenger?.server ?: return
    val app = context.applicationContext
    val media = ArrayList<Uri>()
    for (uri in uris) {
      val (name, type) = AIAttach.describe(app, uri)
      if (type.startsWith("image/") || type.startsWith("video/")) {
        if (pictures.size + media.size >= AIAttach.MAX_PICTURES) taskError = "К вопросу — до ${AIAttach.MAX_PICTURES} фото и кадров." else media.add(uri)
        continue
      }
      reading += 1
      taskError = ""
      Thread({
        val (bytes, tooBig) = AIAttach.bytes(app, uri, AIAttach.MAX_DOCUMENT)
        main.post {
          if (bytes == null) {
            reading -= 1
            taskError = if (tooBig) "«$name» больше 15 МБ." else "Не удалось открыть документ."
            return@post render()
          }
          AIClient.document(server, name, bytes) { result ->
            reading -= 1
            val doc = result.getOrNull()
            if (doc != null) documents = (documents.filter { it.name != doc.name } + doc).takeLast(5)
            else taskError = "«$name»: " + ((result.exceptionOrNull() as? AIFailure)?.words?.takeIf { it.isNotEmpty() } ?: "не удалось прочитать.")
            render()
          }
        }
      }, "invizent.ai.document").apply { isDaemon = true }.start()
    }
    if (media.isNotEmpty()) takePictures(media)
    render()
  }

  /** The emulator check (`--es aidemo photo`): sample attachments and a question (ai/AIAttachments.kt, AIParity). */
  fun demoAttachments(shown: List<AIPicture>, read: List<AIDocumentText>, question: String) {
    pictures = shown
    documents = read
    input.setText(question)
    render()
  }

  /** A debug build's samples (`--es aidemo 1`): a short conversation with a block of code and a sample history, no server. */
  private fun demo() {
    status = AIDemo.status
    if (quick) return render() // the quick dialog: empty, ready for a question
    models = AIDemo.models
    chosenModel = "auto:smart"
    history.show(AIDemo.history)
    AIDemo.history.firstOrNull()?.let { conversationId = it.id }
    restored = true
    conversation.restore(AIDemo.turns, consent = true)
    render()
  }
}
