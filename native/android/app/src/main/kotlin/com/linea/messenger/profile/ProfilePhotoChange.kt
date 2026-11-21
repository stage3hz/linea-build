package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.Picks
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.platina.PlatinaState
import com.linea.messenger.settings.ownProfile
import com.linea.messenger.video.VideoPrepare
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** Changing the profile's photo and banner (the reference's ProfileScreen.tsx `pickMedia`, `applyAvatar`,
 *  `removeMedia` and PlatinaStudio.tsx `upload`; iOS Profile/ProfilePhotoChange.swift): a tap on the avatar or the
 *  banner asks «Фото или GIF», «Видео до 10 секунд» (Platina), «Убрать». A still photo of the avatar goes through the
 *  round cropper; a GIF stays animated; a video (and any banner) is a Platina decoration. A banner photo is shown on
 *  the profile first and uploaded after «Установить баннер». Photos are decoded and written anew (no metadata);
 *  videos are written anew without metadata (video/VideoPrepare.kt). The system's photo picker asks no permission:
 *  it hands over only what the person picks. */
class ProfilePhotoChange(private val context: Context, private val messenger: Messenger) {
  private var kind = "avatar"
  var busy = false
    private set
  /** Busy started or ended (a spinner, «Загружаем…»). */
  var onBusy: ((Boolean) -> Unit)? = null
  /** Words for the person: (words, isError). */
  var onNotice: ((String, Boolean) -> Unit)? = null
  private val work = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  companion object {
    const val AVATAR_EDGE = 1024
    const val PROFILE_LIMIT = 4 * 1024 * 1024
    const val VIDEO_LIMIT = 8 * 1024 * 1024
  }

  private val platina: Boolean get() = PlatinaState.active

  private val activity: Activity?
    get() {
      var c: Context? = context
      while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
      return null
    }

  private fun say(words: String, error: Boolean) {
    onNotice?.let { return it(words, error) }
    if (words.isEmpty()) return
    AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(words).setPositiveButton("Понятно", null).show()
  }

  private fun setBusy(value: Boolean) { busy = value; onBusy?.invoke(value) }

  /** The sheet of a tap on the avatar ("avatar") or the banner ("banner"). */
  fun ask(kind: String) {
    if (busy) return
    this.kind = kind
    val own = PersonLook.from(messenger.ownProfile)
    val hasAvatar = !(messenger.ownProfile["avatarId"] as? String).isNullOrEmpty() || own.avatarVideoId.isNotEmpty()
    val has = if (kind == "avatar") hasAvatar else own.bannerId.isNotEmpty() || own.bannerPreset.isNotEmpty()
    val note = if (platina) null else if (kind == "banner") "Баннер и видео доступны с Platina." else "Видео-аватар доступен с Platina."
    val items = ArrayList<Pair<String, () -> Unit>>()
    if (kind == "avatar" || platina) items.add((if (kind == "banner") "Фото или GIF" else "Выбрать фото или GIF") to { pickPhoto() })
    if (platina) items.add("Видео до 10 секунд" to { pickVideo() })
    if (has) items.add("Убрать" to { remove() })
    val sheet = AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle(if (kind == "banner") "Баннер профиля" else "Фото профиля")
      .setItems(items.map { it.first }.toTypedArray()) { _, which -> items[which].second() }
      .setNegativeButton("Отмена", null)
    if (note != null) sheet.setTitle((if (kind == "banner") "Баннер профиля" else "Фото профиля") + "\n" + note)
    sheet.show()
  }

  fun pickVideoAvatar() { kind = "avatar"; pickVideo() }

  @SuppressLint("InlinedApi")
  private fun picker(type: String): Intent =
    if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).setType(type)
    else Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type)

  // Photos and GIFs

  private fun pickPhoto() {
    val window = activity ?: return
    Picks.ask(window, picker("image/*")) { chosen -> chosen.firstOrNull()?.let { take(it) } }
  }

  private fun take(uri: Uri) {
    val resolver = context.contentResolver
    work.execute {
      val head = try { resolver.openInputStream(uri)?.use { input -> ByteArray(6).also { input.read(it) } } } catch (_: Throwable) { null }
      val gif = head != null && String(head, Charsets.US_ASCII).startsWith("GIF8")
      if (gif) {
        val bytes = try { resolver.openInputStream(uri)?.use { it.readBytes() } } catch (_: Throwable) { null }
        main.post { if (bytes == null) say("Не удалось выбрать файл.", true) else takeGif(bytes) }
        return@execute
      }
      val picture = decode(uri)
      main.post { if (picture == null) say("Не удалось выбрать фото.", true) else takePhoto(picture) }
    }
  }

  /** The picture upright, at most 4096 px across, as a fresh bitmap. */
  private fun decode(uri: Uri): Bitmap? = try {
    val resolver = context.contentResolver
    if (Build.VERSION.SDK_INT >= 28) {
      ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val side = maxOf(info.size.width, info.size.height)
        if (side > 4096) decoder.setTargetSampleSize(Math.ceil(side / 4096.0).toInt())
      }
    } else {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 4096) sample *= 2
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
    }
  } catch (_: Throwable) { null }

  private fun takePhoto(picture: Bitmap) {
    if (kind == "banner") {
      val preview = BannerPreview(context, messenger, picture)
      preview.onSet = { uploadBanner(picture) }
      preview.onAgain = { main.postDelayed({ pickPhoto() }, 350) }
      preview.show()
      return
    }
    val cropper = AvatarCropper(context, picture)
    cropper.onDone = { crop -> applyAvatar(picture, crop) }
    cropper.show()
  }

  private fun jpeg(bitmap: Bitmap, quality: Int): ByteArray? {
    val out = ByteArrayOutputStream()
    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null
    return FileCore.cleanJpeg(out.toByteArray()).getOrNull()
  }

  /** Crop to the circle's square, then an avatar-sized JPEG, as the reference (1024 px, quality 0.86). */
  private fun applyAvatar(picture: Bitmap, crop: Rect) {
    val edge = minOf(AVATAR_EDGE, crop.width()).coerceAtLeast(1)
    val small = Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888)
    Canvas(small).apply { drawColor(0xFF000000.toInt()); drawBitmap(picture, crop, Rect(0, 0, edge, edge), Paint(Paint.FILTER_BITMAP_FLAG)) }
    val bytes = jpeg(small, 86) ?: return say("Не удалось сохранить фото.", true)
    upload(bytes, "avatar.jpg", "image/jpeg", "Не удалось сохранить фото.") { attachment ->
      val type = attachment["mimeType"] as? String ?: "image/jpeg"
      val size = (attachment["size"] as? Number)?.toLong() ?: 0L
      if (!type.startsWith("image/")) return@upload fail("Для профиля нужна фотография.")
      if (size > PROFILE_LIMIT) return@upload fail("После обработки фото больше 4 МБ. Выбери изображение меньшего размера.")
      // Like Telegram: the new photo is applied at once (the name / bio draft stays a draft).
      patch(mapOf("avatarId" to (attachment["id"] as? String ?: "")), "Фото профиля обновлено.", "Не удалось сохранить фото.")
    }
  }

  private fun takeGif(data: ByteArray) {
    if (kind == "banner") {
      upload(data, "banner.gif", "image/gif", "Не удалось загрузить файл.") { attachment -> patch(mapOf("bannerId" to (attachment["id"] as? String ?: "")), "Баннер обновлён.", "Не удалось загрузить файл.") }
      return
    }
    if (data.size > PROFILE_LIMIT) return say("GIF больше 4 МБ. Выбери покороче.", true)
    upload(data, "avatar.gif", "image/gif", "Не удалось сохранить GIF.") { attachment ->
      if (((attachment["size"] as? Number)?.toLong() ?: 0L) > PROFILE_LIMIT) return@upload fail("GIF больше 4 МБ. Выбери покороче.")
      patch(mapOf("avatarId" to (attachment["id"] as? String ?: "")), "Фото профиля обновлено.", "Не удалось сохранить GIF.")
    }
  }

  /** A banner needs no more than ~1500 px across; this also keeps it under the profile limit. */
  private fun uploadBanner(picture: Bitmap) {
    val width = minOf(1500, picture.width).coerceAtLeast(1)
    val height = Math.round(picture.height.toFloat() / maxOf(1, picture.width) * width).coerceAtLeast(1)
    val small = Bitmap.createScaledBitmap(picture, width, height, true)
    val bytes = jpeg(small, 85) ?: return say("Не удалось загрузить файл.", true)
    upload(bytes, "banner.jpg", "image/jpeg", "Не удалось загрузить файл.") { attachment -> patch(mapOf("bannerId" to (attachment["id"] as? String ?: "")), "Баннер обновлён.", "Не удалось загрузить файл.") }
  }

  // Videos

  private fun pickVideo() {
    if (!platina) return
    val window = activity ?: return
    Picks.ask(window, picker("video/*")) { chosen -> chosen.firstOrNull()?.let { takeVideo(it) } }
  }

  private fun takeVideo(uri: Uri) {
    setBusy(true)
    val job = VideoPrepare.Job()
    val avatar = kind == "avatar"
    work.execute {
      val copied = VideoPrepare.copy(context, context.contentResolver, uri, job)
      if (copied == null) { main.post { setBusy(false); say("Не удалось выбрать файл.", true) }; return@execute }
      val seconds = try { MediaMetadataRetriever().run { setDataSource(copied.path); val ms = extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L; release(); ms / 1000.0 } } catch (_: Throwable) { 0.0 }
      // Profile: a longer video is cut to its first ten seconds (profile/ProfileVideoTrim.kt), as iOS's trimmer does.
      if (seconds > 600) { copied.delete(); main.post { setBusy(false); say("Видео — не длиннее 10 секунд.", true) }; return@execute }
      VideoPrepare.prepare(context, copied, job) { result ->
        copied.delete()
        val bytes = result.getOrNull()?.let { prepared ->
          val cut = ProfileVideoTrim.firstSeconds(prepared.file)
          try { cut.readBytes() } catch (_: Throwable) { null }.also { prepared.file.delete(); cut.delete() }
        }
        main.post {
          setBusy(false)
          if (bytes == null) return@post say(VideoPrepare.failed, true)
          if (bytes.size > VIDEO_LIMIT) return@post say("После обработки видео больше 8 МБ. Выбери ролик короче.", true)
          upload(bytes, "profile.mp4", "video/mp4", "Не удалось загрузить файл.") { attachment ->
            val id = attachment["id"] as? String ?: ""
            patch(if (avatar) mapOf("avatarVideoId" to id) else mapOf("bannerId" to id), if (avatar) "Анимированный аватар установлен." else "Баннер обновлён.", "Не удалось загрузить файл.")
          }
        }
      }
    }
  }

  // Sending

  private fun fail(words: String) { setBusy(false); say(words, true) }

  private fun upload(bytes: ByteArray, name: String, mimeType: String, failure: String, then: (Map<String, Any?>) -> Unit) {
    setBusy(true)
    messenger.uploadProfileFile(bytes, name, mimeType) { result ->
      val attachment = result.getOrNull()
      if (attachment != null) then(attachment) else fail(com.linea.messenger.net.Server.error(result).words.ifEmpty { failure })
    }
  }

  private fun patch(fields: Map<String, Any?>, done: String, failure: String) {
    setBusy(true)
    messenger.patchOwnProfile(fields) { result ->
      setBusy(false)
      if (result.isSuccess) say(done, false) else say(com.linea.messenger.net.Server.error(result).words.ifEmpty { failure }, true)
    }
  }

  private fun remove() {
    val fields = if (kind == "avatar") mapOf("avatarId" to null, "avatarVideoId" to null) else mapOf("bannerId" to null, "bannerPreset" to null)
    patch(fields, "", "Не удалось убрать.")
  }
}
