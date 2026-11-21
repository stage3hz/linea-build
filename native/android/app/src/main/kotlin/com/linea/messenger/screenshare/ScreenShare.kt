package com.linea.messenger.screenshare

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import com.linea.messenger.calls.CallMedia
import com.linea.messenger.calls.RoomPeerMedia
import com.linea.messenger.net.Live
import com.linea.messenger.rooms.RoomVoice
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.SecureRandom
import java.util.UUID

/** Screen sharing in a voice channel: the screen part of the reference's communities/voice.ts (`startVoiceScreen`,
 *  `stopVoiceScreen`, `serveScreen`, `bindControl`, the SFU session; iOS ScreenShare/ScreenShare.swift).
 *
 *  - Watching: a person's screen arrives either as a direct copy over their own checked connection (the video slot every
 *    connection reserves, DTLS-SRTP) or through the server's SFU, sealed frame by frame with a key that person sent over
 *    that same checked connection (SfuSession.kt). Their channel (`screen-control`) says whether they share and in which
 *    quality; only then is the picture shown.
 *  - Sharing: the system asks the person (MediaProjection, a new consent for every share, never resumed by itself) and a
 *    foreground service of the type «mediaProjection» holds the capture while it runs, as the reference declares it
 *    (plugins/withScreenBroadcast.js). With the SFU, one sealed upload goes to the server for the viewers who said they
 *    can open «lk» frames (`caps`); every other checked person gets a direct copy. Frames and keys go only to
 *    connections that passed the end-to-end check. Nothing unencrypted goes through any server.
 *
 *  rooms/RoomVoice.kt tells this object about every connection (`attach`, `verified`, `dropped`, the channel's texts).
 *  Main thread only. */
object ScreenShare {
  /** Posted on the main thread when anything about the screens changed. */
  val changed = Live.Signal<Unit>()

  /** A person's screen as the screens show it. */
  class Shown(val peer: String, val userId: String, val quality: ScreenQuality, val track: VideoTrack?)

  /** The quality this phone shares in; null when it does not. */
  var sharing: ScreenQuality? = null
    private set
  /** A share is being started (the system's question is up, or the capture has not begun yet). */
  var starting = false
    private set
  /** Why the last share did not start, in the reference's words (empty: nothing). */
  var error = ""
    private set
  /** This phone's own screen while it shares («Твой экран»). */
  var localTrack: VideoTrack? = null
    private set

  private val main = Handler(Looper.getMainLooper())
  private val medias = HashMap<String, WeakReference<RoomPeerMedia>>()
  private val checked = HashSet<String>()
  private val announced = HashMap<String, Pair<Boolean, ScreenQuality>>()
  private val meshTracks = HashMap<String, VideoTrack>()
  private val sfuTracks = HashMap<String, VideoTrack>()
  private val sfuPeers = HashSet<String>()
  private val pendingKeys = HashMap<String, Pair<Int, ByteArray>>()
  private var sfu: SfuSession? = null
  private var shareKey: Pair<ByteArray, Int>? = null
  private var shareKeyIndex = 0
  private var viaSfu = false
  private var generation = 0
  private var capture: ScreenCapture? = null
  private var app: Context? = null
  private var asking: ((Int, Intent?) -> Unit)? = null
  private var listening = false
  // The emulator check's samples (screenshare/ScreenShareDemo.kt): no media at all.
  private var demo = false
  private var demoScreens: List<Shown> = emptyList()
  val demoFrames = HashMap<String, Bitmap>()
  val isDemo: Boolean get() = demo

  private const val ASK = 7311

  private val heard: (Map<String, Any?>) -> Unit = { data -> event(data) }
  private val voiceMoved: (Unit) -> Unit = { moved() }

  private fun listen() {
    if (listening) return
    listening = true
    Live.roomEvent.watch(heard)
    RoomVoice.changed.watch(voiceMoved)
  }

  private fun tell() {
    changed.post(Unit)
  }

  /** The screens of the people this phone is connected to, in the order of the room. */
  val screens: List<Shown>
    get() {
      if (demo) return demoScreens
      val voice = RoomVoice.state ?: return emptyList()
      val out = ArrayList<Shown>()
      for (peer in voice.peers) {
        val said = announced[peer.peer]
        if (said != null) {
          // Shown once the person says they share: the copy through the server when there is one, else the direct copy.
          val shown = sfuTracks[peer.peer] ?: meshTracks[peer.peer]
          if (said.first && shown != null) out.add(Shown(peer.peer, peer.userId, said.second, shown))
        } else sfuTracks[peer.peer]?.let { out.add(Shown(peer.peer, peer.userId, ScreenQuality.P1080, it)) } // before the channel said anything: 1080p, as the reference assumes
      }
      return out
    }

  // ---- What RoomVoice tells ----

  /** A new connection to a person (whatever was known of the old one is forgotten). */
  fun attach(peer: String, media: RoomPeerMedia) {
    listen()
    medias[peer] = WeakReference(media)
    checked.remove(peer); announced.remove(peer); meshTracks.remove(peer)
    media.onVideo = { track -> if (medias[peer]?.get() === media) { meshTracks[peer] = track; tell() } }
    tell()
  }

  /** The person's channel opened: they hear whether this phone shares, and what it can open (`sendScreenState`, `sendCaps`). */
  fun channelOpened(peer: String) { sendState(peer); sendCaps(peer) }

  /** A text of the person's channel. True when it was about the screen (and is not passed on). */
  fun message(peer: String, text: String, verified: Boolean): Boolean {
    if (text.length > 512) return false
    val extra = try { JSONObject(text) } catch (_: Exception) { return false }
    when (extra.opt("type") as? String ?: return false) {
      "caps" -> {
        // The person can watch through the server; their keys travel only over this channel.
        if (extra.opt("lk") == true && sfu != null) {
          sfuPeers.add(peer)
          // Already sharing: this viewer now gets the picture from the server — the direct copy stops.
          if (localTrack != null && viaSfu && shareKey != null && peer in checked) { sendKey(peer); medias[peer]?.get()?.setScreen(null, null) }
        }
        return true
      }
      "screenKey" -> {
        val index = (extra.opt("keyId") as? Number)?.toInt() ?: return true
        val key = extra.opt("key") as? String ?: return true
        if (index < 0 || index >= 256 || key.length > 44) return true
        val raw = try { Base64.decode(key, Base64.DEFAULT) } catch (_: Exception) { return true }
        if (raw.size != 16) return true
        if (verified) sfu?.setPeerKey(peer, index, raw) else pendingKeys[peer] = index to raw
        return true
      }
      "screen" -> {
        val said = ScreenShareModel.control(text) ?: return true
        announced[peer] = said
        tell()
        return true
      }
    }
    return false
  }

  /** The connection is proven end to end: the frame key that waited, and the screen (`onVerified`). */
  fun verified(peer: String) {
    checked.add(peer)
    pendingKeys.remove(peer)?.let { sfu?.setPeerKey(peer, it.first, it.second) }
    if (localTrack == null || sharing == null) return
    if (viaSfu && peer in sfuPeers) sendKey(peer) else serve(peer)
  }

  /** The connection came up: the screen's cap is set again for it. */
  fun connected(peer: String) {
    if (localTrack == null || sharing == null || peer !in checked || (viaSfu && peer in sfuPeers)) return
    serve(peer)
  }

  /** The person left, or their connection was refused. */
  fun dropped(peer: String) {
    medias.remove(peer); checked.remove(peer); announced.remove(peer); meshTracks.remove(peer); sfuTracks.remove(peer)
    sfuPeers.remove(peer); pendingKeys.remove(peer)
    sfu?.forget(peer)
    tell()
  }

  /** This phone left the room (or the account): nothing of the screens goes on. */
  fun voiceEnded() {
    if (demo) return
    stop()
    sfu?.close(); sfu = null
    medias.clear(); checked.clear(); announced.clear(); meshTracks.clear(); sfuTracks.clear(); sfuPeers.clear(); pendingKeys.clear()
    error = ""
    tell()
  }

  private fun moved() {
    if (demo && RoomVoice.state == null) { demo = false; demoScreens = emptyList(); sharing = null; starting = false; localTrack = null; error = "" }
    if (demo) return
    if (RoomVoice.state == null && (sfu != null || sharing != null || starting || medias.isNotEmpty())) voiceEnded()
  }

  // ---- The live line ----

  private fun event(data: Map<String, Any?>) {
    val type = data["type"] as? String ?: return
    if (demo) return
    if (type.startsWith("sfu.")) { sfu?.handle(data); return }
    val voice = RoomVoice.state ?: return
    if (type == "voice.joined" && data["channelId"] == voice.roomId && voice.communityId != null && data["sfu"] == true && sfu == null) {
      // Many viewers through the server (community channels only; rooms are a mesh).
      val context = app ?: return
      val session = SfuSession(context) { frame -> RoomVoice.messenger?.live?.send(frame) ?: false }
      session.onRemote = { peer, track -> if (track != null) sfuTracks[peer] = track else sfuTracks.remove(peer); tell() }
      sfu = session
      session.start { fine ->
        if (sfu !== session) return@start
        if (fine) for (peer in medias.keys.toList()) sendCaps(peer) else { session.close(); sfu = null }
      }
    } else if (type == "ready") {
      // The live line reconnected: the server forgot this phone (and its SFU transports); it walks in again.
      stop()
      sfu?.close(); sfu = null
      sfuPeers.clear(); sfuTracks.clear()
      tell()
    }
  }

  // ---- Messages to the people ----

  private fun say(peer: String, value: Map<String, Any?>) { medias[peer]?.get()?.send(ScreenShareModel.json(value)) }

  private fun sendState(peer: String) = say(peer, mapOf("type" to "screen", "active" to (sharing != null), "quality" to (sharing ?: ScreenQuality.P720).raw))

  /** `sfu`: opens legacy-layout SFU frames (computers only); `lk`: opens «lk» frames (this phone's FrameCryptor). */
  private fun sendCaps(peer: String) = say(peer, mapOf("type" to "caps", "sfu" to false, "lk" to (sfu != null)))

  private fun sendKey(peer: String) {
    val key = shareKey ?: return
    say(peer, mapOf("type" to "screenKey", "keyId" to key.second, "key" to Base64.encodeToString(key.first, Base64.NO_WRAP)))
  }

  /** A direct copy of this phone's screen for one checked person (`serveScreen`). */
  private fun serve(peer: String) {
    val track = localTrack ?: return
    val quality = sharing ?: return
    medias[peer]?.get()?.setScreen(track, quality.maxBitrate)
  }

  // ---- Sharing ----

  /** «720p · 60 FPS» / «1080p · 60 FPS»: explicit consent in the system's question for every new share; never resumed by
   *  itself. `done` gets null, or the words that say why not. */
  fun start(activity: Activity, quality: ScreenQuality, done: (String?) -> Unit) {
    val voice = RoomVoice.state
    if (voice == null || voice.status != "connected") return done("Сначала подключись к голосовому каналу.")
    if (starting || sharing != null) return done("Демонстрация уже запускается или включена.")
    app = activity.applicationContext
    listen()
    generation += 1
    val attempt = generation
    starting = true
    error = ""
    tell()
    val fail: (String) -> Unit = { words -> stop(); error = words; tell(); done(words) }
    val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager ?: return fail("Не удалось включить демонстрацию.")
    asking = { code, data ->
      asking = null
      if (attempt != generation) Unit
      else if (code != Activity.RESULT_OK || data == null) fail("Запуск демонстрации отменён или не подтверждён.")
      else ScreenCaptureService.begin(activity.applicationContext) {
        // The service is in the foreground now: the capture may begin (Android 14 asks it in this order).
        if (attempt != generation) return@begin
        val made = ScreenCapture.open(activity.applicationContext, data, quality) { main.post { if (capture != null) stop() } }
        if (made == null) fail("Не удалось включить демонстрацию.") else began(attempt, quality, made, done)
      }
    }
    try { activity.startActivityForResult(manager.createScreenCaptureIntent(), ASK) } catch (_: Exception) { asking = null; fail("Не удалось включить демонстрацию.") }
  }

  /** The system's answer about the screen (MainActivity's onActivityResult). True when it was this one's. */
  fun result(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
    if (requestCode != ASK) return false
    asking?.invoke(resultCode, data)
    return true
  }

  private fun began(attempt: Int, quality: ScreenQuality, made: ScreenCapture, done: (String?) -> Unit) {
    if (attempt != generation) { made.stop(); return }
    capture = made
    localTrack = made.track
    sharing = quality
    error = ""
    tell()
    val finish: (Boolean) -> Unit = finish@{ sfuFine ->
      if (attempt != generation) return@finish
      viaSfu = sfuFine
      // Direct copies only for the checked people the server does not serve.
      for (peer in medias.keys.toList()) if (peer in checked && !(sfuFine && peer in sfuPeers)) serve(peer)
      starting = false
      for (peer in medias.keys.toList()) sendState(peer)
      tell()
      done(null)
    }
    // Through the SFU: one sealed upload for all its viewers; key index 0..15 (the FrameCryptor's ring), a new key per share.
    val session = sfu ?: return finish(false)
    shareKeyIndex = (shareKeyIndex + 1) % ScreenFrameKeys.RING
    val raw = ByteArray(16).also { SecureRandom().nextBytes(it) }
    shareKey = raw to shareKeyIndex
    for (peer in medias.keys.toList()) if (peer in sfuPeers && peer in checked) sendKey(peer)
    session.publish(made.track, raw, shareKeyIndex, quality.maxBitrate) { fine -> finish(fine) }
  }

  /** «Остановить демонстрацию» (and «Отменить запуск»): the capture ends, every copy stops. */
  fun stop() {
    if (demo) { sharing = null; starting = false; localTrack = null; tell(); return }
    generation += 1
    val wasOn = sharing != null || starting || capture != null
    asking = null
    capture?.stop()
    capture = null
    app?.let { ScreenCaptureService.end(it) }
    for (held in medias.values) held.get()?.setScreen(null, null)
    sfu?.unpublish()
    shareKey = null
    viaSfu = false
    sharing = null
    starting = false
    localTrack = null
    for (peer in medias.keys.toList()) sendState(peer)
    if (wasOn) tell()
  }

  /** The notice under the buttons was read. */
  fun clearError() { if (error.isEmpty()) return; error = ""; tell() }

  /** The emulator check (`--es screendemo …`): drawn screens, no media. */
  fun showDemo(screens: List<Triple<String, String, ScreenQuality>>, sharing: ScreenQuality?, starting: Boolean, error: String, frames: Map<String, Bitmap>) {
    demo = true
    demoScreens = screens.map { Shown(it.first, it.second, it.third, null) }
    demoFrames.clear(); demoFrames.putAll(frames)
    this.sharing = sharing; this.starting = starting; this.error = error
    listen()
    tell()
  }
}

/** This phone's screen as a video track: the system's MediaProjection through WebRTC's own screen capturer, scaled to the
 *  quality's long edge, sixty frames a second. */
class ScreenCapture private constructor(private val capturer: ScreenCapturerAndroid, private val helper: SurfaceTextureHelper, private val source: VideoSource, val track: VideoTrack) {
  fun stop() {
    try { capturer.stopCapture() } catch (_: Throwable) {}
    try { capturer.dispose() } catch (_: Throwable) {}
    try { track.dispose() } catch (_: Throwable) {}
    try { source.dispose() } catch (_: Throwable) {}
    try { helper.dispose() } catch (_: Throwable) {}
  }

  companion object {
    fun open(context: Context, permission: Intent, quality: ScreenQuality, ended: () -> Unit): ScreenCapture? = try {
      val capturer = ScreenCapturerAndroid(permission, object : MediaProjection.Callback() { override fun onStop() = ended() })
      val factory = CallMedia.factory(context)
      val helper = SurfaceTextureHelper.create("invizent.screen", CallMedia.egl.eglBaseContext)
      val source = factory.createVideoSource(true)
      capturer.initialize(helper, context, source.capturerObserver)
      // The picture keeps the screen's shape; its long edge is the quality's.
      val metrics = context.resources.displayMetrics
      val portrait = metrics.heightPixels >= metrics.widthPixels
      val long = quality.width
      val across = long * minOf(metrics.widthPixels, metrics.heightPixels) / maxOf(1, maxOf(metrics.widthPixels, metrics.heightPixels)) / 2 * 2
      val w = if (portrait) across else long
      val h = if (portrait) long else across
      capturer.startCapture(w, h, quality.frameRate)
      ScreenCapture(capturer, helper, source, factory.createVideoTrack(UUID.randomUUID().toString().lowercase(), source))
    } catch (_: Throwable) { null }
  }
}

/** Holds the screen capture while it runs: a foreground service of the type «mediaProjection» with its notice, as the
 *  system asks (the reference's manifest: FOREGROUND_SERVICE_MEDIA_PROJECTION). Not exported: only the app starts it. */
class ScreenCaptureService : Service() {
  companion object {
    private const val CHANNEL = "invizent.screen"
    private var ready: (() -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())

    fun begin(context: Context, then: () -> Unit) {
      ready = then
      try {
        val intent = Intent(context, ScreenCaptureService::class.java)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      } catch (_: Exception) { ready = null; then() }
    }

    fun end(context: Context) {
      ready = null
      try { context.stopService(Intent(context, ScreenCaptureService::class.java)) } catch (_: Exception) {}
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    try { manager?.createNotificationChannel(NotificationChannel(CHANNEL, "Демонстрация экрана", NotificationManager.IMPORTANCE_LOW)) } catch (_: Exception) {}
    val notice = Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_slideshow).setContentTitle("Демонстрация экрана").setContentText("Всё, что видно на экране, может попасть в трансляцию.").setOngoing(true).build()
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(7311, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(7311, notice)
    } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
    val then = ready
    ready = null
    if (then != null) main.post(then)
    return START_NOT_STICKY
  }
}
