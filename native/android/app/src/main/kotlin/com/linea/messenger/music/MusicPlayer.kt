package com.linea.messenger.music

import android.os.Handler
import android.os.Looper
import com.linea.messenger.ai.AIModel
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import java.io.File
import java.io.InputStream
import java.util.UUID
import kotlin.random.Random

/** What makes the sound. The real one is the platform's MediaPlayer with audio focus (music/MusicService.kt,
 *  `MediaEngine`); a check on the JVM gives its own. Everything is called on the main thread. */
interface MusicEngine {
  /** Something a screen shows has changed: ready, waiting for data, playing or not. */
  var onState: (() -> Unit)?
  /** The track played to its end. */
  var onEnded: (() -> Unit)?
  /** The source could not be played. */
  var onFailed: (() -> Unit)?
  /** Asked to play (also while it is still waiting for data). */
  val playing: Boolean
  /** The source is open and can play. */
  val ready: Boolean
  /** Waiting for more data in the middle of a track. */
  val waiting: Boolean
  /** Seconds. */
  val position: Double
  /** Seconds; 0 while unknown. */
  val duration: Double
  /** Opens a source: an https address, or the path of a file of the app's own folder. */
  fun load(source: String, local: Boolean)
  /** False when the system does not let the app sound now (a call is on). */
  fun play(): Boolean
  fun pause()
  fun seek(seconds: Double)
  /** Stops and lets the source go. */
  fun silence()
  /** Nothing is going to be played any more: the sound is given back to the system. */
  fun rest()
}

/** Where the library's list and the person's own files are kept on this device. */
interface MusicStore {
  fun read(): String?
  fun write(text: String)
  /** The app's own folder for imported audio; no other app can read it. */
  val folder: File?
}

/** What the player asks of the app around it (music/MusicService.kt, `MusicHost`). */
interface MusicSurroundings {
  /** A track was chosen: the playback is to outlive the page (the foreground service, the media notification). */
  fun started()
  /** The player was closed. */
  fun stopped()
}

/** A list of listeners, told on the main thread. */
class MusicSignal {
  private val listeners = LinkedHashSet<() -> Unit>()
  fun watch(listener: () -> Unit) { listeners.add(listener) }
  fun unwatch(listener: () -> Unit) { listeners.remove(listener) }
  fun fire() { for (listener in listeners.toList()) listener() }
}

/** An audio file the person chose, before it is copied into the app's own folder. */
class MusicIncoming(val name: String, val size: Long, val mimeType: String?, val open: () -> InputStream?)

/** The one music player of the app: the queue, what plays, the favourites and the person's own files.
 *  Ported from mobile/src/music/MusicProvider.tsx (iOS: Music/MusicPlayer.swift). Plays on while the app is not
 *  on the screen (a foreground service of the kind `mediaPlayback`) and is driven from the lock screen, the
 *  notification and a headset as well. Everything here lives on the main thread; `changed` is fired whenever
 *  something a screen shows has changed. */
class MusicPlayer(
  /** Where a catalogue's track plays from (never contacted by a check on the JVM: it gives its own). */
  private val resolve: (MusicTrack, Server?, (Result<String>) -> Unit) -> Unit = MusicCatalog::resolveStream,
  private val restore: (String, (Result<MusicTrack>) -> Unit) -> Unit = MusicCatalog::audiusTrack,
  private val random: Random = Random.Default,
) {
  companion object {
    val shared: MusicPlayer by lazy { MusicPlayer() }
    const val libraryKey = "linea.music.device-library.v1"
    const val maxTracks = 500
    const val maxFileSize = 250L * 1024 * 1024
    val audioExtensions = setOf("mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "aiff", "aif", "caf", "webm", "mp4")
    val extensionMimes = mapOf("mp3" to "audio/mpeg", "m4a" to "audio/mp4", "mp4" to "audio/mp4", "aac" to "audio/aac", "wav" to "audio/wav", "flac" to "audio/flac", "ogg" to "audio/ogg",
      "opus" to "audio/opus", "webm" to "audio/webm", "aiff" to "audio/aiff", "aif" to "audio/aiff", "caf" to "audio/x-caf")
    private val storageName = Regex("^[A-Fa-f0-9-]{36}\\.[A-Za-z0-9]{2,5}$")
    private val keptAudiusId = Regex("^[a-zA-Z0-9_-]{1,100}$")

    fun unique(tracks: List<MusicTrack>): List<MusicTrack> = tracks.distinctBy { it.id }.take(maxTracks)

    /** The kind of an audio file by its name — or, when the name has no known ending, by what the system says of it. */
    fun extension(name: String, mimeType: String?): String? {
      val own = name.substringAfterLast('.', "").lowercase()
      if (own in audioExtensions) return own
      if (own.isNotEmpty() && name.contains('.')) return null
      return extensionMimes.entries.firstOrNull { it.value == mimeType }?.key
    }

    /** A track as the library keeps it. */
    fun track(value: Any?): MusicTrack? {
      val raw = Core.map(value as? Map<*, *>) ?: return null
      val id = (raw["id"] as? String)?.takeIf { it.isNotEmpty() && it.length <= 180 } ?: return null
      val source = (raw["source"] as? String)?.takeIf { it == "audius" || it == "soundcloud" || it == "local" } ?: return null
      val title = raw["title"] as? String ?: return null
      val artist = raw["artist"] as? String ?: return null
      return MusicTrack(id = id, source = source, sourceId = (raw["sourceId"] as? String)?.take(120), title = title.take(300), artist = artist.take(250),
        artworkUrl = MusicCatalog.safeHttpsUrl(raw["artworkUrl"]), duration = maxOf(0.0, (raw["duration"] as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0),
        sourceUrl = MusicCatalog.safeHttpsUrl(raw["sourceUrl"]), downloadable = raw["downloadable"] == true,
        fileName = raw["fileName"] as? String, mimeType = raw["mimeType"] as? String, fileSize = (raw["fileSize"] as? Number)?.toLong(), savedAt = raw["savedAt"] as? String)
    }
  }

  val changed = MusicSignal()
  private val main = Handler(Looper.getMainLooper())
  private var engine: MusicEngine? = null
  private var store: MusicStore? = null
  private var surroundings: MusicSurroundings? = null

  /** The signed-in session: SoundCloud is asked through the person's server. */
  var server: Server? = null
    set(value) { val before = field; field = value; if (value !== before) restoreSoundCloud() }

  var current: MusicTrack? = null
    private set
  var queue: List<MusicTrack> = emptyList()
    private set
  var favorites: List<MusicTrack> = emptyList()
    private set
  var saved: List<MusicTrack> = emptyList()
    private set
  /** off · all · one */
  var repeatMode = "off"
    private set
  var shuffle = false
    private set
  var notice = ""
    private set
  private var playbackError = ""
  private var operationError = ""
  private var resolving = false
  private var sourceReady = false
  private var generation = 0
  private var finished = false
  private val names = HashMap<String, String>()
  private var audiusIds: List<String> = emptyList()
  private var scIds: List<String> = emptyList()
  private val visited = HashSet<String>()
  private var trail: List<String> = emptyList()
  private var startTimer: Runnable? = null
  /** A look without sound (the debug build's samples): shown as playing, nothing is asked of anyone. */
  private var sample = false
  private var samplePosition = 0.0
  private val ticker = object : Runnable {
    override fun run() {
      if (!playing || sample) return
      changed.fire()
      main.postDelayed(this, 500)
    }
  }

  /** Gives the player what it works with on this device. The first call reads the library; later ones change nothing. */
  fun attach(engine: MusicEngine, store: MusicStore, surroundings: MusicSurroundings?) {
    if (this.engine != null) return
    this.engine = engine
    this.store = store
    this.surroundings = surroundings
    engine.onState = { if (current != null) { if (engine.ready) cancelStartTimer(); tell() } }
    engine.onEnded = { ended() }
    engine.onFailed = { if (sourceReady) fail(generation, "Не удалось воспроизвести трек. Попробуй другой источник.") }
    loadLibrary()
  }

  val attached: Boolean get() = engine != null

  // What the screens read

  val playing: Boolean
    get() = if (sample) current != null else current != null && sourceReady && engine?.playing == true

  val loading: Boolean
    get() {
      if (resolving) return true
      val engine = engine ?: return false
      if (current == null || !sourceReady || playbackError.isNotEmpty()) return false
      return !engine.ready || (engine.playing && engine.waiting)
    }

  val position: Double
    get() {
      if (sample) return samplePosition
      if (current == null || !sourceReady) return 0.0
      val seconds = engine?.position ?: 0.0
      return if (seconds.isFinite() && seconds >= 0) seconds else 0.0
    }

  val duration: Double
    get() {
      val current = current ?: return 0.0
      val seconds = if (sourceReady) engine?.duration ?: 0.0 else 0.0
      return if (seconds.isFinite() && seconds > 0) seconds else current.duration
    }

  val error: String get() = operationError.ifEmpty { playbackError }

  fun isFavorite(track: MusicTrack): Boolean = favorites.any { it.id == track.id }

  fun clearError() {
    operationError = ""
    playbackError = ""
    tell()
  }

  fun clearNotice() {
    notice = ""
    tell()
  }

  private fun tell() {
    main.removeCallbacks(ticker)
    if (playing && !sample) main.postDelayed(ticker, 500)
    changed.fire()
  }

  // Playing

  private fun cancelStartTimer() {
    startTimer?.let { main.removeCallbacks(it) }
    startTimer = null
  }

  private fun silence() {
    cancelStartTimer()
    engine?.silence()
  }

  fun play(track: MusicTrack, items: List<MusicTrack>? = null) {
    if (sample) {
      current = track
      if (!items.isNullOrEmpty()) queue = items
      return tell()
    }
    val engine = engine ?: return
    generation += 1
    val mine = generation
    playbackError = ""
    operationError = ""
    resolving = true
    sourceReady = false
    finished = false
    silence()
    val prior = current
    // One service per queue: SoundCloud's tracks never share a queue with another service's.
    val base = if (!items.isNullOrEmpty()) items else if (queue.any { it.id == track.id }) queue else listOf(track)
    var nextQueue = unique(base.filter { it.source == track.source })
    if (nextQueue.none { it.id == track.id }) nextQueue = listOf(track) + nextQueue
    if (nextQueue.map { it.id } != queue.map { it.id }) {
      trail = emptyList()
      visited.clear()
    }
    if (prior != null && prior.id != track.id) trail = (trail + prior.id).takeLast(100)
    visited.add(track.id)
    current = track
    queue = nextQueue
    surroundings?.started()
    tell()
    val owned = saved.firstOrNull { it.id == track.id }
    if (owned != null) {
      val file = file(owned)?.takeIf { it.isFile } ?: return fail(mine, "Файл больше не доступен на устройстве. Импортируй его ещё раз.")
      current = owned
      return start(mine, file.path, local = true)
    }
    if (track.source == "local") return fail(mine, "Файл не найден. Импортируй его с устройства ещё раз.")
    resolve(track, server) { result ->
      if (mine != generation) return@resolve
      val address = result.getOrNull() ?: return@resolve fail(mine, (result.exceptionOrNull() as? MusicFailure)?.words ?: "Не удалось включить трек. Проверь соединение и попробуй ещё раз.")
      // Only an https address without a name and a password in it is ever played.
      if (!address.startsWith("https://", ignoreCase = true) || address.substringAfter("://").substringBefore('/').contains('@')) return@resolve fail(mine, "Источник музыки вернул неподходящий адрес.")
      start(mine, address, local = false)
    }
  }

  private fun fail(mine: Int, words: String) {
    if (mine != generation) return
    cancelStartTimer()
    resolving = false
    sourceReady = false
    playbackError = words
    engine?.pause()
    tell()
  }

  private fun start(mine: Int, source: String, local: Boolean) {
    val engine = engine
    if (mine != generation || engine == null) return
    engine.load(source, local)
    sourceReady = true
    resolving = false
    val timer = Runnable {
      startTimer = null
      if (mine == generation && !engine.ready) fail(mine, "Трек загружается слишком долго. Проверь соединение и попробуй ещё раз.")
    }
    startTimer = timer
    main.postDelayed(timer, 30_000)
    if (!engine.play()) return fail(mine, "Не удалось включить трек. Проверь соединение и попробуй ещё раз.")
    tell()
  }

  fun togglePlayback() {
    if (sample) return
    val current = current ?: return
    val engine = engine ?: return
    if (!sourceReady) return play(current, queue)
    playbackError = ""
    if (engine.playing) engine.pause() else {
      if (finished) {
        finished = false
        engine.seek(0.0)
      }
      engine.play()
    }
    tell()
  }

  /** Starts the sound if it is not on; stops it if it is (the notification, the lock screen and a headset ask for exactly one of the two). */
  fun setPlaying(wanted: Boolean) {
    if (current == null || sample) return
    val now = sourceReady && engine?.playing == true
    if (wanted != now) togglePlayback()
  }

  fun seek(seconds: Double) {
    if (!sourceReady || !seconds.isFinite()) return
    val limit = if (duration > 0) duration else maxOf(0.0, seconds)
    finished = false
    engine?.seek(seconds.coerceIn(0.0, limit))
    tell()
  }

  fun next() {
    val selected = current ?: return
    if (queue.isEmpty()) return
    val index = queue.indexOfFirst { it.id == selected.id }
    var target: MusicTrack? = null
    if (shuffle && queue.size > 1) {
      var others = queue.filter { it.id !in visited }
      if (others.isEmpty() && repeatMode == "all") {
        visited.clear()
        visited.add(selected.id)
        others = queue.filter { it.id != selected.id }
      }
      target = others.randomOrNull(random)
    } else if (index + 1 < queue.size) {
      target = queue[index + 1]
    } else if (repeatMode == "all") {
      target = queue.firstOrNull()
    }
    if (target != null) return play(target, queue)
    if (!sample) engine?.pause()
    notice = "Очередь закончилась. Выбери следующий трек."
    tell()
  }

  fun previous() {
    val selected = current ?: return
    if (position > 3) return seek(0.0)
    val index = queue.indexOfFirst { it.id == selected.id }
    var target: MusicTrack? = null
    if (shuffle && trail.isNotEmpty()) {
      val last = trail.last()
      trail = trail.dropLast(1)
      target = queue.firstOrNull { it.id == last }
    }
    if (target == null && index > 0) target = queue[index - 1]
    if (target == null && repeatMode == "all") target = queue.lastOrNull()
    if (target == null) return seek(0.0)
    play(target, queue)
    // Going back is not a step to come back from: the track just left is not remembered.
    if (shuffle && trail.isNotEmpty()) trail = trail.dropLast(1)
  }

  fun toggleRepeat() {
    repeatMode = if (repeatMode == "off") "all" else if (repeatMode == "all") "one" else "off"
    tell()
  }

  fun toggleShuffle() {
    shuffle = !shuffle
    trail = emptyList()
    visited.clear()
    current?.let { visited.add(it.id) }
    tell()
  }

  fun stop() {
    generation += 1
    sourceReady = false
    if (!sample) silence()
    current = null
    queue = emptyList()
    trail = emptyList()
    visited.clear()
    resolving = false
    playbackError = ""
    if (!sample) {
      engine?.rest()
      surroundings?.stopped()
    }
    tell()
  }

  private fun ended() {
    if (!sourceReady) return
    if (repeatMode == "one") {
      engine?.seek(0.0)
      engine?.play()
      return tell()
    }
    finished = true
    next()
  }

  // The library on this device

  /** The person's own file behind a saved track. */
  fun file(track: MusicTrack): File? {
    val name = names[track.id]?.takeIf { storageName.matches(it) } ?: return null
    return store?.folder?.let { File(it, name) }
  }

  private fun loadLibrary() {
    val store = store ?: return
    store.folder?.mkdirs()
    val parsed = Core.map(Core.value(store.read()) as? Map<*, *>) ?: return
    val version = parsed["version"] as? Number
    if (version != null && version.toDouble() != 1.0) {
      operationError = "Не удалось прочитать музыкальную библиотеку."
      return
    }
    val kept = ArrayList<MusicTrack>()
    for (item in (parsed["saved"] as? List<*>).orEmpty().take(maxTracks)) {
      val entry = Core.map(item as? Map<*, *>) ?: continue
      val track = track(entry["track"])?.takeIf { it.source == "local" } ?: continue
      names[track.id] = entry["file"] as? String ?: continue
      if (file(track)?.isFile == true) kept.add(track) else names.remove(track.id)
    }
    saved = kept
    favorites = unique((parsed["favorites"] as? List<*>).orEmpty().mapNotNull { track(it) }.mapNotNull { favorite -> saved.firstOrNull { it.id == favorite.id } })
    audiusIds = (parsed["audiusFavoriteIds"] as? List<*>).orEmpty().mapNotNull { it as? String }.filter { keptAudiusId.matches(it) }.take(maxTracks)
    scIds = (parsed["soundcloudFavoriteIds"] as? List<*>).orEmpty().mapNotNull { it as? String }.filter { MusicCatalog.isSoundCloudUrn(it) }.take(maxTracks)
    // Only the catalogues' ids are kept on disk: their tracks are asked again into memory.
    var failedAny = false
    var left = audiusIds.size
    for (id in audiusIds) {
      restore(id) { result ->
        left -= 1
        val track = result.getOrNull()
        if (track != null && id in audiusIds) favorites = unique(favorites + track) else failedAny = true
        if (left == 0 && failedAny) notice = "Часть избранного Audius сейчас недоступна. Локальная музыка остаётся на устройстве."
        tell()
      }
    }
  }

  private fun restoreSoundCloud() {
    val server = server
    if (server?.token == null) return
    for (urn in scIds.filter { id -> favorites.none { it.sourceId == id } }.take(60)) {
      MusicCatalog.soundCloudTrack(server, urn) { result ->
        val track = result.getOrNull() ?: return@soundCloudTrack
        if (urn !in scIds) return@soundCloudTrack
        favorites = unique(favorites + track)
        tell()
      }
    }
  }

  /** The library as it is written (the reference's form: both apps read each other's). */
  fun libraryJSON(): String? = Core.text(linkedMapOf(
    "version" to 1,
    "saved" to saved.mapNotNull { track -> names[track.id]?.let { linkedMapOf("track" to track.json, "file" to it) } },
    "favorites" to favorites.filter { it.source == "local" }.map { it.json },
    "audiusFavoriteIds" to audiusIds, "soundcloudFavoriteIds" to scIds,
  ))

  private fun storeLibrary() {
    if (sample) return
    libraryJSON()?.let { store?.write(it) }
  }

  fun toggleFavorite(track: MusicTrack) {
    val present = isFavorite(track)
    val id = track.sourceId
    if (track.source == "audius" && id != null) audiusIds = (if (present) emptyList() else listOf(id)).plus(audiusIds.filter { it != id }).take(maxTracks)
    if (track.source == "soundcloud" && id != null) scIds = (if (present) emptyList() else listOf(id)).plus(scIds.filter { it != id }).take(maxTracks)
    favorites = if (present) favorites.filter { it.id != track.id } else unique(listOf(saved.firstOrNull { it.id == track.id } ?: track) + favorites)
    storeLibrary()
    tell()
  }

  private class Imported(val tracks: List<Pair<MusicTrack, String>>, val error: String)

  /** One file after another into the app's own folder; stops at the first that cannot be taken. Any thread. */
  private fun copy(items: List<MusicIncoming>, folder: File?, room: Int): Imported {
    val made = ArrayList<Pair<MusicTrack, String>>()
    for (item in items) {
      if (made.size >= room) return Imported(made, "В библиотеке уже 500 файлов. Удали ненужные и попробуй снова.")
      val ext = extension(item.name, item.mimeType) ?: return Imported(made, "Выбери аудиофайл: MP3, M4A, WAV, FLAC или другой поддерживаемый формат.")
      if (item.size > maxFileSize) return Imported(made, "Аудиофайл пустой или больше 250 МБ.")
      folder ?: return Imported(made, "Не удалось импортировать аудиофайл. Проверь свободное место и попробуй ещё раз.")
      val storage = UUID.randomUUID().toString().lowercase() + "." + ext
      val target = File(folder, storage)
      var size = 0L
      var problem = ""
      try {
        folder.mkdirs()
        val input = item.open() ?: throw IllegalStateException("closed")
        input.use { from ->
          target.outputStream().use { to ->
            val chunk = ByteArray(256 * 1024)
            while (true) {
              val got = from.read(chunk)
              if (got < 0) break
              size += got
              if (size > maxFileSize) break
              to.write(chunk, 0, got)
            }
          }
        }
        if (size == 0L || size > maxFileSize) problem = "Аудиофайл пустой или больше 250 МБ."
      } catch (_: Exception) {
        problem = "Не удалось импортировать аудиофайл. Проверь свободное место и попробуй ещё раз."
      }
      if (problem.isNotEmpty()) {
        target.delete()
        return Imported(made, problem)
      }
      val name = item.name.substringAfterLast('/')
      val track = MusicTrack(id = "local:" + UUID.randomUUID().toString().lowercase(), source = "local", title = name.substringBeforeLast('.').ifEmpty { name }, artist = "На этом устройстве",
        downloadable = true, fileName = name.take(150), mimeType = extensionMimes[ext], fileSize = size, savedAt = AIModel.nowISO())
      made.add(track to storage)
    }
    return Imported(made, "")
  }

  /** Copies audio files the person chose into the app's own folder. Nothing is sent to a server. The copying
   *  itself is done off the main thread; `done` is called when it is over. */
  fun importFiles(items: List<MusicIncoming>, done: () -> Unit = {}) {
    operationError = ""
    notice = ""
    tell()
    val folder = store?.folder
    val room = maxTracks - saved.size
    Thread({
      val result = copy(items, folder, room)
      main.post {
        for ((track, storage) in result.tracks) {
          names[track.id] = storage
          saved = listOf(track) + saved
        }
        operationError = result.error
        if (result.tracks.isNotEmpty()) {
          storeLibrary()
          notice = "Добавлено файлов: ${result.tracks.size}. Музыка сохранена только на этом устройстве."
        }
        tell()
        done()
      }
    }, "invizent.music.import").apply { isDaemon = true }.start()
  }

  fun removeSaved(track: MusicTrack) {
    if (current?.id == track.id) stop()
    file(track)?.delete()
    names.remove(track.id)
    saved = saved.filter { it.id != track.id }
    favorites = favorites.filter { it.id != track.id }
    queue = queue.filter { it.id != track.id }
    storeLibrary()
    tell()
  }

  fun report(words: String) {
    operationError = words
    tell()
  }

  fun say(words: String) {
    notice = words
    tell()
  }

  /** A look without sound and without anyone asked: the given tracks, one of them «playing» at a place. */
  fun showSample(tracks: List<MusicTrack>, track: MusicTrack, position: Double, liked: List<MusicTrack>) {
    sample = true
    samplePosition = position
    queue = tracks
    current = track
    favorites = liked
    tell()
  }
}
