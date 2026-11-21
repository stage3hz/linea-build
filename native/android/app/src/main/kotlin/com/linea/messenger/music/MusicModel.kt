package com.linea.messenger.music

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.TimeUnit

// The music catalogues, ported from mobile/src/music/types.ts, catalog.ts, api.ts and soundcloud.ts (iOS:
// Music/MusicModel.swift). Audius is asked directly and anonymously (no session, no token, no cookies, no cache,
// no redirects — as in the reference); SoundCloud goes through the person's server. A track is shown only when
// the catalogue says, in a fresh answer, that anyone may listen to it: unknown access flags fail closed.

data class MusicTrack(
  val id: String,
  /** audius · soundcloud · local */
  val source: String,
  val sourceId: String? = null,
  val title: String,
  val artist: String,
  val artworkUrl: String? = null,
  val duration: Double = 0.0,
  val genre: String? = null,
  val mood: String? = null,
  val sourceUrl: String? = null,
  val downloadable: Boolean = false,
  val fileName: String? = null,
  val mimeType: String? = null,
  val fileSize: Long? = null,
  val savedAt: String? = null,
) {
  val json: Map<String, Any?>
    get() = LinkedHashMap<String, Any?>().also { out ->
      out["id"] = id; out["source"] = source; out["title"] = title; out["artist"] = artist; out["artworkUrl"] = artworkUrl; out["duration"] = duration; out["downloadable"] = downloadable
      sourceId?.let { out["sourceId"] = it }
      genre?.let { out["genre"] = it }
      mood?.let { out["mood"] = it }
      sourceUrl?.let { out["sourceUrl"] = it }
      fileName?.let { out["fileName"] = it }
      mimeType?.let { out["mimeType"] = it }
      fileSize?.let { out["fileSize"] = it }
      savedAt?.let { out["savedAt"] = it }
    }
}

class MusicFailure(val words: String, val retryable: Boolean = false) : Exception(words)

class MusicPage(val tracks: List<MusicTrack>, val nextOffset: Int?)

class MusicMood(val id: String, val label: String, val symbol: String, val apiMood: String?)

object MusicCatalog {
  val moods: List<MusicMood> = listOf(
    MusicMood("all", "Всё", "note", null),
    MusicMood("calm", "Спокойно", "drop", "Peaceful"),
    MusicMood("energy", "Энергия", "bolt", "Energizing"),
    MusicMood("focus", "Фокус", "headphones", "Cool"),
    MusicMood("upbeat", "Настроение", "sun", "Upbeat"),
    MusicMood("romantic", "Романтика", "heart", "Romantic"),
    MusicMood("melancholy", "Меланхолия", "moon", "Melancholy"),
  )

  private const val origin = "https://api.audius.co"
  private const val maxResponse = 4 * 1024 * 1024

  /** `3:07`. */
  fun time(seconds: Double): String {
    if (!seconds.isFinite() || seconds < 0) return "0:00"
    val value = seconds.toLong()
    return "${value / 60}:" + String.format(Locale.ROOT, "%02d", value % 60)
  }

  // Validation (catalog.ts)

  private val audiusIdForm = Regex("^[A-Za-z0-9]{1,64}$")
  fun audiusId(value: Any?): String? = (value as? String)?.takeIf { audiusIdForm.matches(it) }

  private val digitsAndDots = Regex("^[\\d.]+$")
  private val numberLabel = Regex("^(\\d+|0x[0-9a-f]*)$")
  private val closedNames = Regex("(?:^|\\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test|onion)$")
  private val hostLabel = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

  /** Validates transport only: https, a public host name, the default port, no credentials, no fragment.
   *  The address is read by hand: whatever is not plainly of that form is refused. */
  fun safeHttpsUrl(value: Any?): String? {
    val text = value as? String ?: return null
    if (text.isEmpty() || text.length > 16384) return null
    if (text.any { it.code <= 0x20 || it.code == 0x7F || it == '\\' }) return null
    if (!text.regionMatches(0, "https://", 0, 8, ignoreCase = true)) return null
    val rest = text.substring(8)
    if (rest.contains('#')) return null
    val authority = rest.substring(0, rest.indexOfFirst { it == '/' || it == '?' }.let { if (it < 0) rest.length else it })
    if (authority.isEmpty() || authority.contains('@') || authority.contains('[') || authority.contains('%')) return null
    val colon = authority.indexOf(':')
    val host = (if (colon < 0) authority else authority.substring(0, colon)).lowercase(Locale.ROOT)
    if (colon >= 0) {
      val port = authority.substring(colon + 1)
      if (port.isNotEmpty() && port.trimStart('0') != "443") return null
    }
    if (!host.contains('.') || host.endsWith(".") || digitsAndDots.matches(host)) return null
    // A last label that is a number (decimal or 0x…) makes the whole name a spelling of an IPv4 address.
    if (numberLabel.matches(host.substringAfterLast('.'))) return null
    if (closedNames.containsMatchIn(host)) return null
    if (!host.split('.').all { hostLabel.matches(it) }) return null
    return text
  }

  private fun record(value: Any?): Map<String, Any?>? = Core.map(value as? Map<*, *>)

  private fun emptyObject(value: Any?): Boolean = value == null || (value is Map<*, *> && value.isEmpty())

  private fun mediaUrl(track: Map<String, Any?>, kind: String): String? = safeHttpsUrl(record(track[kind])?.get("url"))

  /** The search flags are hints, never permission. Unknown access flags fail closed. */
  fun canStream(value: Any?): Boolean {
    val track = record(value) ?: return false
    val access = record(track["access"])
    val authorities = track["access_authorities"]
    return audiusId(track["id"]) != null && track["is_available"] == true && track["is_streamable"] == true && track["is_delete"] == false
      && track["is_unlisted"] == false && track["is_stream_gated"] == false && access?.get("stream") == true
      // A present allowlist, including [], is not permission for an anonymous app.
      && track["allowed_api_keys"] == null && (authorities == null || (authorities is List<*> && authorities.isEmpty()))
      && emptyObject(track["stream_conditions"]) && mediaUrl(track, "stream") != null
  }

  /** Artist-enabled public download; this is not an offline-storage licence. */
  fun canDownload(value: Any?): Boolean {
    val track = record(value) ?: return false
    if (!canStream(track)) return false
    val access = record(track["access"])
    val flag = if (track.containsKey("is_downloadable")) track["is_downloadable"] else track["downloadable"]
    return flag == true && track["is_download_gated"] == false && access?.get("download") == true && emptyObject(track["download_conditions"]) && mediaUrl(track, "download") != null
  }

  private fun clean(value: Any?, limit: Int): String? =
    (value as? String)?.filter { it.code > 0x1F && it.code != 0x7F }?.trim()?.take(limit)?.takeIf { it.isNotEmpty() }

  private val pagePath = Regex("^/[^/]+/[^/]+/?$")

  /** The track's page on audius.co: `/artist/track`, nothing else. */
  private fun pageUrl(value: Any?): String? {
    val text = value as? String ?: return null
    if (text.isEmpty() || text.startsWith("//")) return null
    val path = when {
      text.startsWith("/") -> text
      text.startsWith("https://audius.co/") -> text.substring("https://audius.co".length)
      // Another address altogether (it names a scheme), or a path without its first slash.
      text.substringBefore('/').contains(':') -> return null
      else -> "/$text"
    }
    if (path.contains('?') || path.contains('#') || !pagePath.matches(path)) return null
    return safeHttpsUrl("https://audius.co$path")
  }

  fun normalize(value: Any?): MusicTrack? {
    if (!canStream(value)) return null
    val raw = record(value) ?: return null
    val id = audiusId(raw["id"]) ?: return null
    val user = record(raw["user"])
    // Every displayed release keeps its artist credit and official source link.
    val title = clean(raw["title"], 240) ?: return null
    val artist = clean(user?.get("name"), 160) ?: clean(user?.get("handle"), 160) ?: return null
    val link = pageUrl(raw["permalink"]) ?: return null
    val artwork = record(raw["artwork"])
    val duration = (raw["duration"] as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }?.let { Math.rint(it) } ?: 0.0
    return MusicTrack(id = "audius:$id", source = "audius", sourceId = id, title = title, artist = artist,
      artworkUrl = safeHttpsUrl(artwork?.get("480x480")) ?: safeHttpsUrl(artwork?.get("150x150")) ?: safeHttpsUrl(artwork?.get("1000x1000")),
      duration = duration, genre = clean(raw["genre"], 80), mood = clean(raw["mood"], 80), sourceUrl = link, downloadable = canDownload(raw))
  }

  /** One page of a catalogue's answer (`data` of it). */
  fun page(raw: Any?, offset: Int, limit: Int): MusicPage {
    val list = raw as? List<*> ?: throw MusicFailure("Сервис музыки вернул неверный ответ. Попробуйте позже.")
    val seen = HashSet<String>()
    val tracks = ArrayList<MusicTrack>()
    for (item in list) {
      val track = normalize(item) ?: continue
      if (seen.add(track.id)) tracks.add(track)
    }
    // A full page of unavailable records must not end the pages early.
    return MusicPage(tracks, if (list.size >= limit) offset + list.size else null)
  }

  // Audius requests (api.ts)

  private val main: Handler by lazy { Handler(Looper.getMainLooper()) }

  /** The app's one client and its rules — TLS only, the system's certificate checks, no cookie jar, no cache, a
   *  redirect is never followed — with this catalogue's own time limit. Nothing of the messenger's session is
   *  ever added to these requests. */
  private val client: OkHttpClient by lazy { Server.client.newBuilder().callTimeout(12, TimeUnit.SECONDS).build() }

  /** What an answer of Audius means, by its status and body. */
  fun readAnswer(status: Int, body: ByteArray?): Result<Map<String, Any?>> = when {
    status == 429 -> Result.failure(MusicFailure("Audius временно ограничил запросы. Подождите немного и попробуйте снова."))
    status == 401 || status == 403 -> Result.failure(MusicFailure("Эта музыка сейчас недоступна через Audius."))
    status == 404 -> Result.failure(MusicFailure("Трек больше недоступен в Audius."))
    status !in 200..299 -> Result.failure(MusicFailure("Сервис музыки временно недоступен. Попробуйте позже.", retryable = status >= 500))
    body == null -> Result.failure(MusicFailure("Сервис музыки вернул слишком большой ответ."))
    else -> record(Core.value(String(body, Charsets.UTF_8)))?.let { Result.success(it) } ?: Result.failure(MusicFailure("Не удалось прочитать ответ Audius. Попробуйте позже."))
  }

  private fun once(path: String): Result<Map<String, Any?>> {
    val request = try { Request.Builder().url("$origin/v1$path").header("Accept", "application/json").get().build() } catch (_: IllegalArgumentException) { return Result.failure(MusicFailure("Не удалось подключиться к Audius.")) }
    return try {
      client.newCall(request).execute().use { response ->
        val received = ByteArrayOutputStream()
        var whole = true
        response.body?.byteStream()?.let { input ->
          val chunk = ByteArray(64 * 1024)
          while (true) {
            val got = input.read(chunk)
            if (got < 0) break
            if (received.size() + got > maxResponse) { whole = false; break }
            received.write(chunk, 0, got)
          }
        }
        readAnswer(response.code, if (whole) received.toByteArray() else null)
      }
    } catch (error: IOException) {
      Result.failure(MusicFailure(if (error is InterruptedIOException) "Audius не ответил вовремя. Попробуйте ещё раз." else "Не удалось подключиться к Audius. Проверьте интернет.", retryable = true))
    }
  }

  /** No session of the messenger, no user token, no cache, no other host. The answer comes on the main thread. */
  private fun requestJson(path: String, done: (Result<Map<String, Any?>>) -> Unit) {
    work.execute {
      var result = once(path)
      if ((result.exceptionOrNull() as? MusicFailure)?.retryable == true) {
        try { Thread.sleep(300) } catch (_: InterruptedException) {}
        result = once(path)
      }
      main.post { done(result) }
    }
  }

  private val work = java.util.concurrent.Executors.newCachedThreadPool { run -> Thread(run, "invizent.music").apply { isDaemon = true } }

  fun query(items: List<Pair<String, String>>): String =
    items.joinToString("&") { (name, value) -> URLEncoder.encode(name, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8").replace("+", "%20") }

  /** The path of the week's popular tracks, or of a search by words and mood. */
  fun searchPath(text: String, mood: String?, offset: Int, limit: Int): String {
    val wanted = text.trim().take(160)
    val apiMood = moods.firstOrNull { it.id == mood }?.apiMood ?: moods.firstOrNull { it.apiMood != null && it.apiMood == mood }?.apiMood
    val items = arrayListOf("offset" to offset.toString(), "limit" to limit.toString())
    if (wanted.isEmpty() && apiMood == null) return "/tracks/trending?" + query(items + ("time" to "week"))
    if (wanted.isNotEmpty()) items.add("query" to wanted)
    if (apiMood != null) items.add("mood" to apiMood)
    items.add("sort_method" to if (wanted.isEmpty()) "popular" else "relevant")
    // This exact mixed-case parameter comes from the official REST schema.
    items.add("includePurchaseable" to "false")
    return "/tracks/search?" + query(items)
  }

  private fun failure(result: Result<*>, fallback: String): MusicFailure = result.exceptionOrNull() as? MusicFailure ?: MusicFailure(fallback)

  fun searchAudius(text: String, mood: String?, offset: Int, limit: Int, done: (Result<MusicPage>) -> Unit) {
    requestJson(searchPath(text, mood, offset, limit)) { result ->
      val body = result.getOrNull() ?: return@requestJson done(Result.failure(failure(result, "Не удалось найти музыку.")))
      done(try { Result.success(page(body["data"], offset, limit)) } catch (failed: MusicFailure) { Result.failure(failed) })
    }
  }

  /** The track itself out of a fresh answer about it: the answer must be about this very id. */
  fun freshTrack(body: Map<String, Any?>, id: String): Map<String, Any?>? = record(body["data"])?.takeIf { it["id"] == id }

  private fun fresh(sourceId: String?, done: (Result<Map<String, Any?>>) -> Unit) {
    val id = audiusId(sourceId) ?: return done(Result.failure(MusicFailure("Не удалось определить трек Audius.")))
    requestJson("/tracks/$id") { result ->
      val body = result.getOrNull() ?: return@requestJson done(Result.failure(failure(result, "Не удалось подключиться к Audius.")))
      val raw = freshTrack(body, id) ?: return@requestJson done(Result.failure(MusicFailure("Audius вернул неверные данные трека.")))
      done(Result.success(raw))
    }
  }

  /** Restores an Audius favourite from its id (only ids are kept on disk). */
  fun audiusTrack(sourceId: String, done: (Result<MusicTrack>) -> Unit) {
    fresh(sourceId) { result ->
      val raw = result.getOrNull() ?: return@fresh done(Result.failure(result.exceptionOrNull()!!))
      val track = normalize(raw)
      done(if (track != null) Result.success(track) else Result.failure(MusicFailure("Этот трек сейчас недоступен для свободного прослушивания.")))
    }
  }

  /** Where to play the track from: asked from the official endpoint after a fresh permission check. */
  fun resolveStream(track: MusicTrack, server: Server?, done: (Result<String>) -> Unit) {
    if (track.source == "soundcloud") return soundCloudStream(track, server, done)
    val id = (if (track.source == "audius") audiusId(track.sourceId) else null) ?: return done(Result.failure(MusicFailure("Этот источник музыки не поддерживается.")))
    fresh(id) { result ->
      val raw = result.getOrNull() ?: return@fresh done(Result.failure(result.exceptionOrNull()!!))
      if (!canStream(raw)) return@fresh done(Result.failure(MusicFailure("Автор ограничил доступ к треку, или он больше недоступен.")))
      requestJson("/tracks/$id/stream?no_redirect=true") { answer ->
        val body = answer.getOrNull() ?: return@requestJson done(Result.failure(failure(answer, "Не удалось подключиться к Audius.")))
        val uri = safeHttpsUrl(body["data"])
        done(if (uri != null) Result.success(uri) else Result.failure(MusicFailure("Audius не предоставил доступный адрес воспроизведения.")))
      }
    }
  }

  /** The official download address, when the author allows it. Opened outside the app: never kept here. */
  fun resolveDownload(track: MusicTrack, done: (Result<String>) -> Unit) {
    val id = (if (track.source == "audius") audiusId(track.sourceId) else null) ?: return done(Result.failure(MusicFailure("Этот источник музыки не поддерживается.")))
    fresh(id) { result ->
      val raw = result.getOrNull() ?: return@fresh done(Result.failure(result.exceptionOrNull()!!))
      if (!canDownload(raw)) return@fresh done(Result.failure(MusicFailure("Автор не разрешил публичное скачивание этого трека. Его можно открыть в Audius.")))
      done(Result.success("$origin/v1/tracks/$id/download"))
    }
  }

  // SoundCloud through the person's server (soundcloud.ts)

  private val soundCloudUrn = Regex("^soundcloud:tracks:\\d{1,20}$")
  fun isSoundCloudUrn(value: Any?): Boolean = value is String && soundCloudUrn.matches(value)

  private fun ask(server: Server?, path: String, done: (Result<Map<String, Any?>>) -> Unit) {
    if (server?.token == null) return done(Result.failure(MusicFailure("SoundCloud доступен после входа в аккаунт.")))
    server.send("GET", path) { result ->
      main.post { done(if (result.isSuccess) Result.success(record(result.getOrNull()) ?: emptyMap()) else Result.failure(MusicFailure(Server.error(result).words))) }
    }
  }

  fun soundCloudAvailable(server: Server?, done: (Boolean) -> Unit) {
    if (server?.token == null) return done(false)
    ask(server, "/music/soundcloud/status") { result -> done(result.getOrNull()?.get("available") == true) }
  }

  private fun https(input: Any?): String? = (input as? String)?.takeIf { it.regionMatches(0, "https://", 0, 8, ignoreCase = true) }

  /** One track as the person's server gives it. */
  fun soundCloudTrack(value: Any?): MusicTrack? {
    val raw = record(value) ?: return null
    if (raw["source"] != "soundcloud") return null
    val urn = (raw["sourceId"] as? String)?.takeIf { isSoundCloudUrn(it) } ?: return null
    val title = raw["title"] as? String ?: return null
    val artist = raw["artist"] as? String ?: return null
    return MusicTrack(id = "sc:$urn", source = "soundcloud", sourceId = urn, title = title.take(200), artist = artist.take(120), artworkUrl = https(raw["artworkUrl"]),
      duration = maxOf(0.0, (raw["duration"] as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0), genre = (raw["genre"] as? String)?.take(60), sourceUrl = https(raw["sourceUrl"]), downloadable = false)
  }

  /** A page of the person's server's SoundCloud answer. */
  fun soundCloudPage(body: Map<String, Any?>): MusicPage =
    MusicPage((body["tracks"] as? List<*>).orEmpty().mapNotNull { soundCloudTrack(it) }, (body["nextOffset"] as? Number)?.toInt())

  fun searchSoundCloud(server: Server?, text: String, mood: String?, offset: Int, limit: Int, done: (Result<MusicPage>) -> Unit) {
    val items = arrayListOf("offset" to offset.toString(), "limit" to limit.toString())
    val wanted = text.trim().take(160)
    if (wanted.isNotEmpty()) items.add("q" to wanted)
    if (!mood.isNullOrEmpty()) items.add("mood" to mood)
    ask(server, "/music/soundcloud/tracks?" + query(items)) { result -> done(result.map { soundCloudPage(it) }) }
  }

  fun soundCloudTrack(server: Server?, urn: String, done: (Result<MusicTrack>) -> Unit) {
    if (!isSoundCloudUrn(urn)) return done(Result.failure(MusicFailure("Некорректный трек SoundCloud.")))
    ask(server, "/music/soundcloud/tracks/" + Messenger.pathPart(urn)) { result ->
      val body = result.getOrNull() ?: return@ask done(Result.failure(result.exceptionOrNull()!!))
      val track = soundCloudTrack(body["track"])
      done(if (track != null) Result.success(track) else Result.failure(MusicFailure("Этот трек больше недоступен в SoundCloud.")))
    }
  }

  private fun soundCloudStream(track: MusicTrack, server: Server?, done: (Result<String>) -> Unit) {
    val urn = track.sourceId?.takeIf { isSoundCloudUrn(it) } ?: return done(Result.failure(MusicFailure("Некорректный трек SoundCloud.")))
    ask(server, "/music/soundcloud/tracks/" + Messenger.pathPart(urn) + "/stream") { result ->
      val body = result.getOrNull() ?: return@ask done(Result.failure(result.exceptionOrNull()!!))
      val uri = (body["uri"] as? String)?.takeIf { it.startsWith("https://") }
      done(if (uri != null) Result.success(uri) else Result.failure(MusicFailure("SoundCloud не дал адрес для воспроизведения.")))
    }
  }
}
