package com.linea.messenger.channels

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

// «Каналы»: the requests that are not in the core's table of operations — plain files (a channel's attachments
// and pictures are not end-to-end encrypted, by the reference's design) — and the pictures' cache.
// Every request is HTTPS as the signed-in session, through the app's one client (the system's certificate
// checks, redirects never followed, nothing cached).

/** Downloads to a file and one-request uploads. Waits on the calling thread: never call it on the main one. */
object ChannelTransfer {
  /** No file of a channel is taken past this size. */
  private const val MOST = 256L * 1024 * 1024

  /** A request of the signed-in session; null when it cannot be made (no HTTPS address, no headers). */
  fun request(server: Server, method: String, path: String, contentType: String?, body: ByteArray?): Pair<Request, Long>? {
    val token = server.token ?: return null
    if (!server.base.startsWith("https://")) return null
    val made = Core.prepare(method, path, jsonBody = false, token = token, proof = server.currentProof) ?: return null
    return try {
      val builder = Request.Builder().url(server.base + path)
      for ((name, value) in made.headers) builder.header(name, value)
      if (contentType != null) builder.header("Content-Type", contentType)
      val request = builder.method(method, body?.toRequestBody(null)).build()
      if (request.isHttps) Pair(request, made.timeoutMs) else null
    } catch (_: IllegalArgumentException) { null }
  }

  /** Downloads what the request answers into `file`. True when the server answered 200 and the file is there. */
  fun fetch(asked: Pair<Request, Long>, file: File): Boolean {
    val folder = file.parentFile ?: return false
    val part = File(folder, file.name + ".part-" + UUID.randomUUID().toString().take(8))
    return try {
      // A file may take longer than a JSON answer: the limit of the request is on connecting and on silence.
      val client = Server.client.newBuilder().connectTimeout(asked.second, TimeUnit.MILLISECONDS).readTimeout(asked.second, TimeUnit.MILLISECONDS).build()
      client.newCall(asked.first).execute().use { response ->
        val body = response.body
        if (response.code != 200 || body == null) return false
        folder.mkdirs()
        var total = 0L
        part.outputStream().use { out ->
          val chunk = ByteArray(64 * 1024); val input = body.byteStream()
          while (true) {
            val got = input.read(chunk)
            if (got < 0) break
            total += got
            if (total > MOST) throw IOException("too big")
            out.write(chunk, 0, got)
          }
        }
        file.delete()
        part.renameTo(file)
      }
    } catch (_: IOException) { false } finally { part.delete() }
  }

  /** Sends a body and gives the answer's status and text (status 0: no answer came). */
  fun send(asked: Pair<Request, Long>): Pair<Int, String> = try {
    Server.client.newBuilder().callTimeout(maxOf(asked.second, 120_000L), TimeUnit.MILLISECONDS).build().newCall(asked.first).execute().use { Pair(it.code, it.body?.string() ?: "") }
  } catch (_: IOException) { Pair(0, "") }
}

/** `/files/<id>` — where an uploaded file is read from (reference: Api.fileUrl). */
fun channelFilePath(id: String): String = "/files/" + Messenger.pathPart(id)

/** The link of an invitation as it is shared (reference: Api.inviteUrl). */
fun Server.inviteAddress(code: String): String = base + "/i/" + Messenger.pathPart(code)

/** The body of a one-file upload, the same as the reference's `multipartFile` (the part is called `file`). */
object ChannelUpload {
  private val typeRule = Regex("^[\\w.+-]+/[\\w.+-]+$")

  fun safeName(name: String): String {
    val shown = StringBuilder()
    var taken = 0; var index = 0
    while (index < name.length && taken < 200) {
      val point = name.codePointAt(index)
      index += Character.charCount(point); taken += 1
      if (point == '"'.code || point == '\\'.code || point == '\r'.code || point == '\n'.code) shown.append('_') else shown.appendCodePoint(point)
    }
    return shown.toString().ifEmpty { "file" }
  }

  fun safeType(mimeType: String): String = if (typeRule.matches(mimeType)) mimeType else "application/octet-stream"

  fun body(bytes: ByteArray, name: String, mimeType: String, boundary: String): ByteArray {
    val head = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${safeName(name)}\"\r\nContent-Type: ${safeType(mimeType)}\r\n\r\n".toByteArray(Charsets.UTF_8)
    val tail = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)
    return head + bytes + tail
  }
}

/** Uploads one plain file in one multipart request, as the reference's `sendMultipart` does (`POST /uploads`).
 *  `purpose`: "channel" for a channel's attachment, null for a community's picture. Gives the server's
 *  `attachment`. Waits on the calling (background) thread.
 *
 *  A session bound to this device's key needs a fresh proof and an upload cannot repeat itself, so a small
 *  signed-in request goes first (it renews the proof when one is due), and an upload refused for lack of the
 *  proof is sent once more. */
fun Server.uploadPlainFile(bytes: ByteArray, name: String, mimeType: String, purpose: String?): Result<Map<String, Any?>> {
  val unreachable = ServerError.Network("Нет связи с сервером. Проверь интернет и адрес подключения.")
  val path = if (purpose == null) "/uploads" else "/uploads?purpose=$purpose"
  val boundary = "----invizent" + UUID.randomUUID().toString().replace("-", "").lowercase()
  val body = ChannelUpload.body(bytes, name, mimeType, boundary)
  for (attempt in 0 until 2) {
    val warm = sendAndWait("GET", "/e2ee/limits")
    if (warm.isFailure) {
      // The limits themselves are not needed: only no connection or an ended session stops the upload.
      val error = Server.error(warm)
      if (error !is ServerError.Refused || error.status == 401) return Result.failure(error)
    }
    val asked = ChannelTransfer.request(this, "POST", path, "multipart/form-data; boundary=$boundary", body) ?: return Result.failure(unreachable)
    val sent = ChannelTransfer.send(asked)
    if (sent.first == 0) return Result.failure(unreachable)
    val read = Core.read(sent.first, sent.second)
    Core.map(Core.map(read["ok"])?.get("attachment"))?.let { return Result.success(it) }
    val refused = Core.map(read["refused"])
    if (refused != null) {
      if (sent.first == 401 && refused["code"] as? String == "device_proof" && attempt == 0) continue
      return Result.failure(ServerError.Refused(refused["message"] as? String ?: "Не удалось выполнить запрос. Попробуй ещё раз.", sent.first, refused["code"] as? String, refused))
    }
    return Result.failure(ServerError.Network("Сервер недоступен."))
  }
  return Result.failure(ServerError.Network("Не удалось подтвердить устройство. Попробуй ещё раз."))
}

/** The files of channels kept on this device between openings: the app's cache folder, which the system may
 *  empty at any time (the reference keeps them in its cache folder the same way). */
object ChannelFiles {
  /** The app's cache folder; set when the section starts (`ChannelsStore.start`). */
  @Volatile var cache: File? = null

  private fun safe(text: String): String = buildString { for (c in text) append(if (c.isLetterOrDigit() || c == '-' || c == '_' || c == '.') c else '_') }

  /** Where the file with this id is kept under this name; null before the section has started. */
  fun place(id: String, name: String): File? {
    val base = cache ?: return null
    var shown = safe(name)
    if (shown.isEmpty() || shown == "." || shown == "..") shown = "file"
    return File(File(File(base, "channel-files"), safe(id).ifEmpty { "_" }), shown)
  }

  /** The file, downloaded when it is not here yet. Waits on the calling (background) thread. */
  fun bring(server: Server, id: String, name: String): File? {
    val file = place(id, name) ?: return null
    if (file.isFile) return file
    val asked = ChannelTransfer.request(server, "GET", channelFilePath(id), null, null) ?: return null
    return if (ChannelTransfer.fetch(asked, file)) file else null
  }
}

/** The sizes pictures are decoded at: plain arithmetic. */
object ChannelPixels {
  /** How many pixels a picture shown in a box of this size (px) is decoded at. */
  fun pixels(width: Float, height: Float): Int = (maxOf(width, height) * 1.5f).roundToInt()

  /** The size a picture of `width`×`height` is decoded at so that its longer side is at most `pixels`. */
  fun fit(width: Int, height: Int, pixels: Int): Pair<Int, Int> {
    val longer = maxOf(width, height); val most = maxOf(16, pixels)
    if (longer <= most) return Pair(width, height)
    val scale = most.toDouble() / longer
    return Pair(maxOf(1, (width * scale).roundToInt()), maxOf(1, (height * scale).roundToInt()))
  }

  /** The largest power of two a picture can be made smaller by while its longer side stays at least `pixels`. */
  fun sample(width: Int, height: Int, pixels: Int): Int {
    var by = 1
    while (maxOf(width, height) / (by * 2) >= maxOf(16, pixels)) by *= 2
    return by
  }
}

/** The pictures the section shows — attachments, people, communities. A picture is read from the cache folder
 *  (or downloaded into it), decoded OFF the main thread straight at the size it is shown at, and kept in memory
 *  under a limit counted in bytes. */
object ChannelImages {
  /** Posted on the main thread when a picture has arrived (or failed): the file's id. */
  val ready = Live.Signal<String>()

  /** The session the pictures are asked as. Main thread. */
  var server: Server? = null
  private val memory = object : LruCache<String, Bitmap>(48 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = maxOf(1, value.byteCount) }
  private val loading = HashSet<String>()
  private val failedAt = HashMap<String, Long>()
  private val work = Executors.newFixedThreadPool(3) { run -> Thread(run, "invizent.channel-images").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }
  private val main = Handler(Looper.getMainLooper())
  /** For the debug build's samples: pictures that are simply there, at whatever size they are asked for. */
  private val samples = HashMap<String, Bitmap>()

  /** Main thread only. The picture at `pixels` on its longer side; null while it is not here — `ready` is
   *  posted when it is. */
  fun image(id: String, pixels: Int): Bitmap? {
    if (id.isEmpty()) return null
    samples[id]?.let { return it }
    val key = "$id@$pixels"
    memory.get(key)?.let { return it }
    if (loading.contains(key)) return null
    val failed = failedAt[key]
    if (failed != null && SystemClock.elapsedRealtime() - failed < 60_000) return null
    val server = server ?: return null
    loading.add(key)
    work.execute {
      var made: Bitmap? = null
      val file = ChannelFiles.bring(server, id, "picture")
      if (file != null) {
        made = decode(file, pixels)
        // Not a picture after all: the bytes are not kept.
        if (made == null) file.delete()
      }
      main.post {
        loading.remove(key)
        if (made != null) { memory.put(key, made); failedAt.remove(key) } else failedAt[key] = SystemClock.elapsedRealtime()
        ready.post(id)
      }
    }
    return null
  }

  /** Main thread only. Whether the picture at `pixels` is still on its way (`ready` will be posted for it). */
  fun waiting(id: String, pixels: Int): Boolean = loading.contains("$id@$pixels")

  /** A new account: the pictures of the previous one are not shown to it. Main thread. */
  fun forget() {
    memory.evictAll(); loading.clear(); failedAt.clear()
  }

  fun putSample(image: Bitmap, id: String) { samples[id] = image }

  /** The picture of a file, decoded at once at no more than `pixels` on its longer side, upright. Any thread. */
  fun decode(file: File, pixels: Int): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 28) NewDecoder.decode(file, pixels) else decodeOld(file, pixels)
  } catch (_: Throwable) { null }

  @android.annotation.TargetApi(28)
  private object NewDecoder {
    fun decode(file: File, pixels: Int): Bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
      val size = ChannelPixels.fit(info.size.width, info.size.height, pixels)
      decoder.setTargetSize(size.first, size.second)
      // Drawn through a shader on any canvas (and counted in the cache by its bytes).
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
  }

  private fun decodeOld(file: File, pixels: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = ChannelPixels.sample(bounds.outWidth, bounds.outHeight, pixels) }
    val raw = BitmapFactory.decodeFile(file.path, options) ?: return null
    val size = ChannelPixels.fit(raw.width, raw.height, pixels)
    val matrix = Matrix()
    matrix.setScale(size.first.toFloat() / raw.width, size.second.toFloat() / raw.height)
    when (try { ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
    }
    if (matrix.isIdentity) return raw
    val turned = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
    if (turned !== raw) raw.recycle()
    return turned
  }
}
