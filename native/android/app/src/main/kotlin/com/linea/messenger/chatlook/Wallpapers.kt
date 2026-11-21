package com.linea.messenger.chatlook

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.Shader
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Live
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.ThemeStore
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/** One chat wallpaper (the reference's wallpapers.ts): a preset gradient or the person's own picture, for all
 *  chats or one chat. Kept only on this phone (pictures in the app's own folder); never sent anywhere. */
data class WallpaperChoice(
  /** "preset" or "image". */
  val kind: String,
  /** A preset's id («none», «aurora», …). */
  val preset: String = "none",
  /** The picture's file name in the app's wallpapers folder. */
  val file: String = "",
  val blur: Boolean = false,
  val motion: Boolean = false,
  val dim: Double = 0.2,
  /** How the picture is fitted (wallpaperFit.ts): its width / height, the zoom and the shift as shares of the screen. */
  val aspect: Double = 0.0,
  val zoom: Double = 1.0,
  val fx: Double = 0.0,
  val fy: Double = 0.0,
) {
  val isImage: Boolean get() = kind == "image"

  /** The preset's colours; null for «Как фон» and for a picture. */
  val colors: List<Int>? get() = if (kind == "preset") Wallpapers.presetColors(preset) else null

  /** A wallpaper is on (a gradient or a picture): the chat then shows its words in bubbles, as in the reference. */
  val shown: Boolean get() = isImage || colors != null

  val fields: Map<String, Any?>
    get() = if (isImage) mapOf("kind" to "image", "file" to file, "blur" to blur, "motion" to motion, "dim" to dim, "aspect" to aspect, "zoom" to zoom, "fx" to fx, "fy" to fy)
    else mapOf("kind" to "preset", "id" to preset)

  companion object {
    fun preset(id: String) = WallpaperChoice("preset", preset = id)

    /** A stored choice read back, as `parseWallpapers` does: anything unknown or broken is dropped. */
    fun read(raw: Any?, ids: List<String> = Wallpapers.presetIds): WallpaperChoice? {
      val item = Core.map(raw as? Map<*, *>) ?: return null
      val id = item["id"] as? String
      if (item["kind"] == "preset" && id != null && ids.contains(id)) return preset(id)
      val file = item["file"] as? String ?: return null
      if (item["kind"] != "image" || file.isEmpty() || file.contains("/")) return null
      fun number(name: String, fallback: Double): Double = (item[name] as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: fallback
      val dim = number("dim", 0.2)
      val aspect = number("aspect", 0.0)
      return WallpaperChoice("image", file = file, blur = item["blur"] == true, motion = item["motion"] == true,
        dim = if (dim in listOf(0.0, 0.2, 0.4, 0.6)) dim else 0.2, aspect = if (aspect > 0.05 && aspect < 20) aspect else 0.0,
        zoom = number("zoom", 1.0).coerceIn(1.0, WallpaperFit.MAX_ZOOM),
        fx = number("fx", 0.0).coerceIn(-WallpaperFit.MAX_ZOOM, WallpaperFit.MAX_ZOOM), fy = number("fy", 0.0).coerceIn(-WallpaperFit.MAX_ZOOM, WallpaperFit.MAX_ZOOM))
    }
  }
}

/** How the person's own picture is fitted (the reference's wallpaperFit.ts, the same maths). */
object WallpaperFit {
  const val MAX_ZOOM = 4.0

  /** The size the picture is drawn at to cover a `width` × `height` screen at zoom 1. */
  fun cover(aspect: Double, width: Double, height: Double): Pair<Double, Double> {
    val a = if (aspect > 0 && aspect.isFinite()) aspect else width / maxOf(1.0, height)
    return if (a > width / maxOf(1.0, height)) Pair(height * a, height) else Pair(width, width / a)
  }

  /** The fit kept inside its limits: zoom 1…4, never moved so far that an edge shows. */
  fun clamp(zoom: Double, fx: Double, fy: Double, aspect: Double, width: Double, height: Double): Triple<Double, Double, Double> {
    val z = (if (zoom.isFinite()) zoom else 1.0).coerceIn(1.0, MAX_ZOOM)
    if (width <= 0 || height <= 0) return Triple(z, 0.0, 0.0)
    val size = cover(aspect, width, height)
    val maxX = maxOf(0.0, (size.first * z - width) / 2 / width); val maxY = maxOf(0.0, (size.second * z - height) / 2 / height)
    val x = if (fx.isFinite()) fx else 0.0; val y = if (fy.isFinite()) fy else 0.0
    return Triple(z, x.coerceIn(-maxX, maxX), y.coerceIn(-maxY, maxY))
  }
}

/** Where the choices are kept: the global one and those of single chats. */
object Wallpapers {
  /** Posted when a wallpaper or the bubbles changed. */
  val changed = Live.Signal<Unit>()
  const val KEY = "invizent.wallpapers.v1"

  class Preset(val id: String, val label: String, val colors: List<Int>?)

  /** The presets as the core lists them (the reference's WALLPAPERS: id, label, colours or none). */
  val presets: List<Preset>
    get() {
      val result = ThemeStore.list("wallpapers").mapNotNull { item ->
        val id = item["id"] as? String ?: return@mapNotNull null
        val label = item["label"] as? String ?: return@mapNotNull null
        val colors = (item["colors"] as? List<*>)?.mapNotNull { LookColor.hex(it as? String) }
        Preset(id, label, colors?.takeIf { it.isNotEmpty() })
      }
      if (result.isNotEmpty()) return result
      // The reference's own list, should the core not answer.
      return listOf(Preset("none", "Как фон", null), Preset("aurora", "Аврора", listOf(0x0E2A47, 0x1B3F6B, 0x3A2A63)), Preset("night", "Ночь", listOf(0x05060B, 0x0B1020, 0x121A33)),
        Preset("mint", "Мята", listOf(0x0D3B3A, 0x145650, 0x1E3B5A)), Preset("sunset", "Закат", listOf(0x3B1838, 0x5A2440, 0x2A1E4A)),
        Preset("violet", "Фиолет", listOf(0x3A2D8F, 0x5B3FB8, 0x2B5BB5)))
    }

  val presetIds: List<String> get() = presets.map { it.id }

  fun presetColors(id: String): List<Int>? = presets.firstOrNull { it.id == id }?.colors

  /** The emulator check: a choice shown without being kept. */
  var demo: WallpaperChoice? = null

  /** The app's folder for pictures (set once the app starts a chat; files are not backed up). */
  private var folderPath: File? = null

  fun folder(context: Context): File {
    folderPath?.let { return it }
    val made = File(context.applicationContext.noBackupFilesDir, "wallpapers")
    made.mkdirs()
    folderPath = made
    return made
  }

  private fun stored(): Pair<WallpaperChoice?, Map<String, WallpaperChoice>> {
    val value = Core.map(Core.value(ThemeStore.kept?.get(KEY)) as? Map<*, *>) ?: return Pair(null, emptyMap())
    val chats = HashMap<String, WallpaperChoice>()
    for ((id, item) in Core.map(value["chats"] as? Map<*, *>).orEmpty()) {
      val choice = WallpaperChoice.read(item)
      if (choice != null && id.length == 36) chats[id] = choice
    }
    return Pair(WallpaperChoice.read(value["global"]), chats)
  }

  private fun files(global: WallpaperChoice?, chats: Map<String, WallpaperChoice>): Set<String> =
    (listOf(global) + chats.values).mapNotNull { if (it != null && it.isImage) it.file else null }.toSet()

  private fun save(global: WallpaperChoice?, chats: Map<String, WallpaperChoice>) {
    val before = stored().let { files(it.first, it.second) }
    val value = mapOf("chats" to chats.mapValues { it.value.fields }, "global" to global?.fields)
    Core.text(value)?.let { ThemeStore.kept?.set(KEY, it) }
    // Pictures no wallpaper uses any more are deleted.
    val after = files(global, chats)
    folderPath?.let { folder -> for (name in before - after) File(folder, name).delete() }
    changed.post(Unit)
  }

  /** The wallpaper of a chat: its own, else the global one, else the preset of the preferences. */
  fun choice(chatId: String): WallpaperChoice {
    demo?.let { return it }
    val all = stored()
    if (chatId.isNotEmpty()) all.second[chatId]?.let { return it }
    all.first?.let { return it }
    return WallpaperChoice.preset(DevicePreferences.word("wallpaper") ?: "none")
  }

  fun hasOwn(chatId: String): Boolean = stored().second.containsKey(chatId)

  /** Sets a wallpaper for one chat (`chatId`) or for all (null removes it). */
  fun set(choice: WallpaperChoice?, chatId: String?) {
    val all = stored()
    if (!chatId.isNullOrEmpty()) {
      val chats = HashMap(all.second)
      if (choice == null) chats.remove(chatId) else chats[chatId] = choice
      save(all.first, chats)
    } else save(choice, all.second)
  }

  /** Keeps a picked picture as a phone-screen-sized JPEG (1600 px wide at most) in the app's folder; its file name. */
  fun keep(context: Context, image: Bitmap): String? = try {
    val picture = if (image.width > 1600) Bitmap.createScaledBitmap(image, 1600, Math.round(1600f * image.height / image.width), true) else image
    val name = UUID.randomUUID().toString().lowercase() + ".jpg"
    FileOutputStream(File(folder(context), name)).use { picture.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    name
  } catch (_: Throwable) { null }

  /** A picture picked and then not used is deleted (unless a wallpaper uses it). */
  fun discard(context: Context, file: String) {
    if (file.isEmpty() || file.contains("/")) return
    val all = stored()
    if (files(all.first, all.second).contains(file)) return
    File(folder(context), file).delete()
  }

  fun image(context: Context, file: String): Bitmap? {
    if (file.isEmpty() || file.contains("/")) return null
    return try { BitmapFactory.decodeFile(File(folder(context), file).path) } catch (_: Throwable) { null }
  }

  internal val pool = Executors.newSingleThreadExecutor()
}

/** A chat's wallpaper behind the messages (the reference's `ChatWallpaper`): a preset gradient, or the picture with
 *  its blur, dimming (dark themes) and the slight movement with the phone's tilt. */
class WallpaperView(context: Context) : FrameLayout(context), SensorEventListener {
  private val paint = Paint(Paint.DITHER_FLAG)
  private val picture = ImageView(context).apply { scaleType = ImageView.ScaleType.MATRIX }
  private val veil = View(context).apply { setBackgroundColor(0xFF000000.toInt()) }
  private var choice = WallpaperChoice.preset("none")
  private var shownFile = ""
  private var bitmap: Bitmap? = null
  private var tiltX = 0f
  private var tiltY = 0f
  private var sensors: SensorManager? = null

  init {
    setWillNotDraw(false)
    isClickable = false
    addView(picture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(veil, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun show(next: WallpaperChoice) {
    choice = next
    picture.visibility = if (next.isImage) View.VISIBLE else View.GONE
    veil.visibility = if (next.isImage && Theme.dark && next.dim > 0) View.VISIBLE else View.GONE
    veil.alpha = next.dim.toFloat()
    if (next.isImage && next.file != shownFile) {
      shownFile = next.file
      bitmap = Wallpapers.image(context, next.file)
      picture.setImageBitmap(bitmap)
    }
    // «Размытие»: the picture blurred as the reference's `blurRadius={18}` (Android 12 and later).
    if (Build.VERSION.SDK_INT >= 31) picture.setRenderEffect(if (next.isImage && next.blur) RenderEffect.createBlurEffect(18f * resources.displayMetrics.density, 18f * resources.displayMetrics.density, Shader.TileMode.CLAMP) else null)
    listen(next.isImage && next.motion && AvatarMotion.enabled(context) && isAttachedToWindow)
    fit()
    invalidate()
  }

  /** The preview: the fit follows the fingers. */
  fun fit(zoom: Double, fx: Double, fy: Double) {
    choice = choice.copy(zoom = zoom, fx = fx, fy = fy)
    fit()
  }

  private fun fit() {
    val image = bitmap ?: return
    val width = width.toDouble(); val height = height.toDouble()
    if (width <= 0 || height <= 0 || image.width <= 0) return
    var aspect = choice.aspect
    if (aspect <= 0) aspect = image.width.toDouble() / image.height
    val size = WallpaperFit.cover(aspect, width, height)
    val fitted = WallpaperFit.clamp(choice.zoom, choice.fx, choice.fy, aspect, width, height)
    // «Движение»: drawn 8 % larger, it follows the phone's tilt by up to 14 dp.
    val grown = if (choice.motion) 1.08 else 1.0
    val scale = (size.first / image.width * fitted.first * grown).toFloat()
    val d = resources.displayMetrics.density
    val cx = (width / 2 + fitted.second * width).toFloat() + tiltX * 14f * d
    val cy = (height / 2 + fitted.third * height).toFloat() + tiltY * 14f * d
    val m = Matrix()
    m.setScale(scale, scale)
    m.postTranslate(cx - image.width * scale / 2, cy - image.height * scale / 2)
    picture.imageMatrix = m
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); fit() }

  override fun onDraw(canvas: Canvas) {
    val colors = choice.colors ?: return
    if (colors.size < 2) { canvas.drawColor(LookColor.argb(colors.firstOrNull() ?: 0)); return }
    paint.shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), colors.map { LookColor.argb(it) }.toIntArray(), null, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    paint.shader = null
  }

  private fun listen(on: Boolean) {
    if (on && sensors == null) {
      val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
      val sensor = manager.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
      manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI, Handler(Looper.getMainLooper()))
      sensors = manager
    } else if (!on && sensors != null) {
      sensors?.unregisterListener(this)
      sensors = null
      tiltX = 0f; tiltY = 0f
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    // The tilt as a share of gravity, softened; the picture moves against it.
    val nx = (-event.values[0] / 9.81f).coerceIn(-1f, 1f); val ny = (event.values[1] / 9.81f - 0.6f).coerceIn(-1f, 1f)
    tiltX += (nx - tiltX) * 0.15f; tiltY += (ny - tiltY) * 0.15f
    fit()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  override fun onAttachedToWindow() { super.onAttachedToWindow(); show(choice) }
  override fun onDetachedFromWindow() { listen(false); super.onDetachedFromWindow() }
}
