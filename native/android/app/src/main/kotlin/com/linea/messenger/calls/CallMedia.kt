package com.linea.messenger.calls

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.Camera2Enumerator
import livekit.org.webrtc.CameraVideoCapturer
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.DefaultVideoDecoderFactory
import livekit.org.webrtc.DefaultVideoEncoderFactory
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.SurfaceViewRenderer
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import java.util.UUID

/** The media of one call: the microphone, the camera, and the connection between the two phones (WebRTC —
 *  LiveKit's build of milestone 150, `io.github.webrtc-sdk:android-prefixed:150.7871.01`, the very one the
 *  reference app links through react-native-webrtc; its classes are in the package `livekit.org.webrtc`). The
 *  picture and the sound go phone to phone, encrypted by the connection's own keys (DTLS-SRTP); a relay, when
 *  one is needed, forwards ciphertext.
 *
 *  This is the only file that knows WebRTC. It decides nothing: the engine (CallEngine.kt) tells it what to
 *  do and hears what happened, always on the main thread. */
class CallMedia private constructor(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private var connection: PeerConnection? = null
  private val streamId = UUID.randomUUID().toString().lowercase()
  private var audioTrack: AudioTrack? = null
  private var audioSource: AudioSource? = null
  private var videoSource: VideoSource? = null
  private var capturer: CameraVideoCapturer? = null
  private var cameraHelper: SurfaceTextureHelper? = null
  private var frontCamera = true
  private var lastState = ""
  private var closed = false
  internal var localVideoTrack: VideoTrack? = null
    private set
  internal var remoteVideoTrack: VideoTrack? = null
    private set

  /** A local address was found (the candidate line, e.g. «… typ relay …»). */
  var onCandidate: ((String) -> Unit)? = null
  /** The gathering of addresses moved on (see `gatheringComplete`). */
  var onGathering: (() -> Unit)? = null
  /** The connection's state: "new", "connecting", "connected", "disconnected", "failed" or "closed". */
  var onState: ((String) -> Unit)? = null
  /** The other side's picture appeared. */
  var onRemoteVideo: (() -> Unit)? = null

  /** What the connection says, on WebRTC's own thread: each word is carried to the main one. */
  private val observer = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) { main.post { tellState() } }
    override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) { main.post { tellState() } }
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) { main.post { onGathering?.invoke() } }
    override fun onIceCandidate(candidate: IceCandidate?) {
      val line = candidate?.sdp ?: return
      main.post { onCandidate?.invoke(line); onGathering?.invoke() }
    }
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
    override fun onAddStream(stream: MediaStream?) {}
    override fun onRemoveStream(stream: MediaStream?) {}
    override fun onDataChannel(channel: DataChannel?) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
      val track = receiver?.track() as? VideoTrack ?: return
      main.post {
        if (closed) return@post
        remoteVideoTrack = track
        onRemoteVideo?.invoke()
      }
    }
  }

  // The camera

  val hasCamera: Boolean get() = localVideoTrack != null

  /** Adds this phone's camera to the call (at the start of a video call, or when «Видео» is switched on during
   *  an audio call — a new offer has to follow then). The front camera first; 640×480 at 30 frames a second, as
   *  the reference asks (or the nearest the camera has). */
  fun addCamera() {
    val connection = connection ?: return
    if (localVideoTrack != null) return
    try {
      val cameras = Camera2Enumerator(context)
      val names = cameras.deviceNames
      val name = names.firstOrNull { cameras.isFrontFacing(it) } ?: names.firstOrNull() ?: return
      frontCamera = cameras.isFrontFacing(name)
      val made = cameras.createCapturer(name, null) ?: return
      val source = factory(context).createVideoSource(false)
      val helper = SurfaceTextureHelper.create("invizent.call-camera", egl.eglBaseContext)
      made.initialize(helper, context, source.capturerObserver)
      made.startCapture(640, 480, 30)
      val track = factory(context).createVideoTrack(UUID.randomUUID().toString().lowercase(), source)
      capturer = made
      cameraHelper = helper
      videoSource = source
      localVideoTrack = track
      connection.addTrack(track, listOf(streamId))
    } catch (_: Exception) {
      // No camera to open: the call goes on without this phone's picture.
    }
  }

  fun setCamera(on: Boolean) { try { localVideoTrack?.setEnabled(on) } catch (_: Exception) {} }

  /** The other camera of the phone. */
  fun flipCamera() {
    val capturer = capturer ?: return
    try {
      capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
        override fun onCameraSwitchDone(front: Boolean) { main.post { frontCamera = front } }
        override fun onCameraSwitchError(error: String?) {}
      })
    } catch (_: Exception) {}
  }

  val usesFrontCamera: Boolean get() = frontCamera

  fun setMicrophone(on: Boolean) { try { audioTrack?.setEnabled(on) } catch (_: Exception) {} }

  // Offers and answers

  val signalingState: String get() = try { connection?.signalingState()?.name?.lowercase()?.replace('_', '-') ?: "closed" } catch (_: Exception) { "closed" }

  val gatheringComplete: Boolean get() = try { connection?.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE } catch (_: Exception) { false }
  /** This phone's SDP as the connection holds it now (with the addresses gathered so far). */
  val localSdp: String get() = try { connection?.localDescription?.description ?: "" } catch (_: Exception) { "" }

  /** What the making of an SDP, or the taking of one, ended with (on WebRTC's own thread). */
  private open inner class Heard(private val made: ((String?) -> Unit)? = null, private val taken: ((Boolean) -> Unit)? = null) : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) { val sdp = description?.description; main.post { made?.invoke(sdp) } }
    override fun onCreateFailure(error: String?) { main.post { made?.invoke(null) } }
    override fun onSetSuccess() { main.post { taken?.invoke(true) } }
    override fun onSetFailure(error: String?) { main.post { taken?.invoke(false) } }
  }

  /** A new offer; `iceRestart`: with new addresses for the same call. null when it cannot be made. */
  fun makeOffer(iceRestart: Boolean, done: (String?) -> Unit) {
    val connection = connection ?: return done(null)
    val constraints = MediaConstraints()
    if (iceRestart) constraints.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
    try { connection.createOffer(Heard(made = done), constraints) } catch (_: Exception) { done(null) }
  }

  fun makeAnswer(done: (String?) -> Unit) {
    val connection = connection ?: return done(null)
    try { connection.createAnswer(Heard(made = done), MediaConstraints()) } catch (_: Exception) { done(null) }
  }

  private fun sessionDescription(kind: String, sdp: String): SessionDescription =
    SessionDescription(when (kind) { "offer" -> SessionDescription.Type.OFFER; "answer" -> SessionDescription.Type.ANSWER; else -> SessionDescription.Type.ROLLBACK }, sdp)

  /** `kind`: "offer", "answer" or "rollback" (takes this phone's pending offer back). `done`: whether it was taken. */
  fun setLocal(kind: String, sdp: String, done: (Boolean) -> Unit) {
    val connection = connection ?: return done(false)
    try { connection.setLocalDescription(Heard(taken = done), sessionDescription(kind, sdp)) } catch (_: Exception) { done(false) }
  }

  fun setRemote(kind: String, sdp: String, done: (Boolean) -> Unit) {
    val connection = connection ?: return done(false)
    try { connection.setRemoteDescription(Heard(taken = done), sessionDescription(kind, sdp)) } catch (_: Exception) { done(false) }
  }

  // The link

  /** Caps what a sender may send ("audio" or "video"), bits per second; null lifts the cap. */
  fun cap(kind: String, bitrate: Double?) {
    val connection = connection ?: return
    try {
      for (sender in connection.senders) {
        if (sender.track()?.kind() != kind) continue
        val parameters = sender.parameters
        val encoding = parameters.encodings.firstOrNull() ?: continue
        encoding.maxBitrateBps = bitrate?.toInt()
        sender.parameters = parameters
      }
    } catch (_: Exception) {}
  }

  /** The connection's own statistics as plain entries (`id`, `type` and the numbers, words and flags of each). */
  fun statistics(done: (List<Map<String, Any?>>) -> Unit) {
    val connection = connection ?: return done(emptyList())
    try {
      connection.getStats { report ->
        val list = ArrayList<Map<String, Any?>>()
        for (entry in report.statsMap.values) {
          val item = LinkedHashMap<String, Any?>()
          for ((key, value) in entry.members) {
            when (value) {
              is Boolean -> item[key] = value
              is Number -> value.toDouble().let { if (it.isFinite()) item[key] = it }
              is String -> item[key] = value
            }
          }
          item["id"] = entry.id
          item["type"] = entry.type
          list.add(item)
        }
        main.post { done(list) }
      }
    } catch (_: Exception) { done(emptyList()) }
  }

  /** Tells the state when it is not the one told last. Also asked once a second by the engine, so a change is
   *  never missed. */
  fun tellState() {
    val connection = connection ?: return
    if (closed) return
    val state = try { connection.connectionState().name.lowercase() } catch (_: Exception) { return }
    if (state == lastState) return
    lastState = state
    onState?.invoke(state)
  }

  /** The call is over: the camera and the microphone are released, the connection closed. Nothing is told after it. */
  fun close() {
    if (closed) return
    closed = true
    onCandidate = null
    onGathering = null
    onState = null
    onRemoteVideo = null
    try { capturer?.stopCapture() } catch (_: Exception) {}
    try { capturer?.dispose() } catch (_: Exception) {}
    capturer = null
    try { cameraHelper?.dispose() } catch (_: Exception) {}
    cameraHelper = null
    val camera = localVideoTrack
    val microphone = audioTrack
    localVideoTrack = null
    remoteVideoTrack = null
    audioTrack = null
    try { connection?.dispose() } catch (_: Exception) {}
    connection = null
    // The connection lets go of what the other side sent; this phone's own tracks and sources are this file's.
    try { camera?.dispose() } catch (_: Exception) {}
    try { microphone?.dispose() } catch (_: Exception) {}
    try { videoSource?.dispose() } catch (_: Exception) {}
    videoSource = null
    try { audioSource?.dispose() } catch (_: Exception) {}
    audioSource = null
  }

  companion object {
    /** The drawing context the camera, the codecs and the pictures on the screen share. */
    internal val egl: EglBase by lazy { EglBase.create() }
    private var made: PeerConnectionFactory? = null

    /** One factory for the app's life: the phone's own echo cancellation and noise suppression, the default
     *  video codecs. Rooms (RoomMedia.kt) make their connections with the same one: the app has one audio module. */
    internal fun factory(context: Context): PeerConnectionFactory {
      made?.let { return it }
      val app = context.applicationContext
      PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
      val sound = JavaAudioDeviceModule.builder(app).setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true).createAudioDeviceModule()
      val built = PeerConnectionFactory.builder()
        .setAudioDeviceModule(sound)
        .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
        .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
        .createPeerConnectionFactory()
      sound.release()
      made = built
      return built
    }

    /** `iceServers`: the server's answer to `GET /calls/ice` (`urls` — a text or a list, `username`, `credential`).
     *  The microphone is opened here, and the camera for a video call: the permissions were asked before.
     *  null when the connection cannot be made. */
    fun create(context: Context, iceServers: List<Map<String, Any?>>, video: Boolean): CallMedia? {
      val media = CallMedia(context.applicationContext)
      try {
        val servers = ArrayList<PeerConnection.IceServer>()
        for (server in iceServers) {
          val urls = (server["urls"] as? List<*>)?.mapNotNull { it as? String } ?: (server["urls"] as? String)?.let { listOf(it) } ?: emptyList()
          if (urls.isEmpty()) continue
          val builder = PeerConnection.IceServer.builder(urls)
          (server["username"] as? String)?.let { builder.setUsername(it) }
          (server["credential"] as? String)?.let { builder.setPassword(it) }
          servers.add(builder.createIceServer())
        }
        val config = PeerConnection.RTCConfiguration(servers)
        config.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        val factory = factory(media.context)
        val connection = factory.createPeerConnection(config, media.observer) ?: return null
        media.connection = connection
        // Noise suppression, echo cancellation and automatic gain: the phone's own audio processing.
        val processing = MediaConstraints()
        for (name in listOf("googAutoGainControl", "googNoiseSuppression", "googEchoCancellation")) processing.optional.add(MediaConstraints.KeyValuePair(name, "true"))
        val source = factory.createAudioSource(processing)
        media.audioSource = source
        val track = factory.createAudioTrack(UUID.randomUUID().toString().lowercase(), source)
        media.audioTrack = track
        connection.addTrack(track, listOf(media.streamId))
        if (video) media.addCamera()
        return media
      } catch (_: Throwable) {
        // The library is not in the app, or the phone cannot make a connection: the call says «Не удалось начать звонок».
        media.close()
        return null
      }
    }
  }
}

/** A picture of the call on the screen: the other side's (full screen) or this phone's own (the small one,
 *  mirrored for the front camera). Draws nothing until it is given a call's media. */
class CallVideoView(context: Context) : FrameLayout(context) {
  private var surface: SurfaceViewRenderer? = null
  private var track: VideoTrack? = null
  /** The small picture lies over the large one. */
  var onTop = false

  init { setBackgroundColor(0xFF000000.toInt()) }

  private fun show(next: VideoTrack?) {
    if (track === next) return
    val before = track
    val shown = surface
    if (before != null && shown != null) try { before.removeSink(shown) } catch (_: Exception) {}
    track = next
    if (next == null) {
      if (shown != null) {
        removeView(shown)
        try { shown.release() } catch (_: Exception) {}
      }
      surface = null
      return
    }
    try {
      val made = shown ?: SurfaceViewRenderer(context).also { made ->
        made.init(CallMedia.egl.eglBaseContext, null)
        made.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        made.setEnableHardwareScaler(true)
        if (onTop) made.setZOrderMediaOverlay(true)
        addView(made, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER))
        surface = made
      }
      next.addSink(made)
    } catch (_: Throwable) { track = null }
  }

  /** The other side's picture of this call (null: nothing). */
  fun showRemote(media: CallMedia?) = show(media?.remoteVideoTrack)

  /** This phone's own camera; the front one is shown as in a mirror. */
  fun showLocal(media: CallMedia?) {
    show(media?.localVideoTrack)
    try { surface?.setMirror(media?.usesFrontCamera ?: true) } catch (_: Exception) {}
  }
}
