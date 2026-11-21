package com.linea.messenger.calls

import android.content.Context
import android.os.Handler
import android.os.Looper
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpSender
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.UUID

/** The microphone of the room this phone is in: one track, shared by the connections to everyone inside.
 *  The phone's own echo cancellation, noise suppression and gain, as in a one-to-one call (CallMedia.kt).
 *  null when the microphone cannot be opened (the permission was asked before). */
class RoomMicrophone private constructor(internal val source: AudioSource, internal val track: AudioTrack) {
  internal val streamId: String = UUID.randomUUID().toString().lowercase()

  fun set(on: Boolean) { try { track.setEnabled(on) } catch (_: Exception) {} }

  /** The room is over: every connection is closed already. */
  fun release() {
    try { track.dispose() } catch (_: Exception) {}
    try { source.dispose() } catch (_: Exception) {}
  }

  companion object {
    fun open(context: Context): RoomMicrophone? = try {
      val factory = CallMedia.factory(context.applicationContext)
      val processing = MediaConstraints()
      for (name in listOf("googAutoGainControl", "googNoiseSuppression", "googEchoCancellation")) processing.optional.add(MediaConstraints.KeyValuePair(name, "true"))
      val source = factory.createAudioSource(processing)
      RoomMicrophone(source, factory.createAudioTrack(UUID.randomUUID().toString().lowercase(), source))
    } catch (_: Throwable) { null }
  }
}

/** The connection to one person inside a room (a room is a full mesh: every two people have their own connection,
 *  encrypted by its own keys — DTLS-SRTP; a relay, when one is needed, forwards ciphertext). Voice only: the
 *  reference's room carries no camera. Next to the voice runs a small text channel (`screen-control`, the name the
 *  reference gives it) that carries «music for everyone».
 *
 *  Until the engine has checked the connection end to end (rooms/RoomVoice.kt), this phone's microphone is not
 *  put into it and what arrives over it is not played.
 *
 *  With CallMedia.kt, the only code that knows WebRTC. It decides nothing; everything is told on the main thread. */
class RoomPeerMedia private constructor(private val microphone: RoomMicrophone) {
  private val main = Handler(Looper.getMainLooper())
  private var connection: PeerConnection? = null
  private var micSender: RtpSender? = null
  /** ScreenShare: the video slot every connection reserves (screenshare/ScreenShare.kt); this phone's screen goes in it. */
  private var screenSender: RtpSender? = null
  /** ScreenShare: the person's screen arrived over this connection (their copy over the checked link). */
  var onVideo: ((livekit.org.webrtc.VideoTrack) -> Unit)? = null
  private var channel: DataChannel? = null
  private var audible = false
  private var lastState = ""
  private var closed = false
  private var gatherDone: ((String) -> Unit)? = null
  private var gatherTimer: Runnable? = null

  /** The connection's state: "new", "connecting", "connected", "disconnected", "failed" or "closed". */
  var onState: ((String) -> Unit)? = null
  /** A text arrived over the peer-to-peer channel. */
  var onMessage: ((String) -> Unit)? = null
  /** The peer-to-peer channel opened. */
  var onChannelOpen: (() -> Unit)? = null

  /** What a data channel says, on WebRTC's own thread. */
  private inner class Listener(private val heard: DataChannel) : DataChannel.Observer {
    override fun onBufferedAmountChange(previous: Long) {}
    override fun onStateChange() {
      val open = try { heard.state() == DataChannel.State.OPEN } catch (_: Exception) { false }
      main.post { if (!closed && channel === heard && open) onChannelOpen?.invoke() }
    }
    override fun onMessage(buffer: DataChannel.Buffer) {
      if (buffer.binary) return
      // The buffer lives only while this call lasts: its bytes are copied out first.
      val bytes = ByteArray(buffer.data.remaining())
      buffer.data.get(bytes)
      val text = String(bytes, Charsets.UTF_8)
      main.post { if (!closed && channel === heard) onMessage?.invoke(text) }
    }
  }

  /** What the connection says, on WebRTC's own thread: each word is carried to the main one. */
  private val observer = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) { main.post { tellState() } }
    override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) { main.post { tellState() } }
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
      val complete = state == PeerConnection.IceGatheringState.COMPLETE
      main.post { if (!closed && complete) gatheringSettled() }
    }
    override fun onIceCandidate(candidate: IceCandidate?) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
    override fun onAddStream(stream: MediaStream?) {}
    override fun onRemoveStream(stream: MediaStream?) {}
    override fun onDataChannel(opened: DataChannel?) {
      val made = opened ?: return
      main.post {
        if (closed || (try { made.label() } catch (_: Exception) { "" }) != "screen-control") return@post
        channel = made
        made.registerObserver(Listener(made))
        if ((try { made.state() } catch (_: Exception) { null }) == DataChannel.State.OPEN) onChannelOpen?.invoke()
      }
    }
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
      // Whatever arrives is silent until the connection is checked.
      val video = try { receiver?.track() as? livekit.org.webrtc.VideoTrack } catch (_: Exception) { null } // ScreenShare: the person's screen slot
      main.post {
        if (closed) return@post
        setAudible(audible)
        if (video != null) onVideo?.invoke(video) // ScreenShare
      }
    }
  }

  // What is let through

  /** The connection is checked (or no longer is): this phone's microphone goes into it, or is taken out. */
  fun setMicrophone(live: Boolean) { try { micSender?.setTrack(if (live) microphone.track else null, false) } catch (_: Exception) {} }

  /** Whether what arrives over this connection is played. */
  fun setAudible(on: Boolean) {
    audible = on
    val connection = connection ?: return
    try {
      for (receiver in connection.receivers) {
        val track = receiver.track() ?: continue
        if (track.kind() == "audio") track.setEnabled(on)
      }
    } catch (_: Exception) {}
  }

  /** ScreenShare: this phone's screen goes into the connection (null: out of it), with the quality's cap. */
  fun setScreen(track: livekit.org.webrtc.VideoTrack?, maxBitrate: Int?) {
    val sender = screenSender ?: return
    try {
      sender.setTrack(track, false)
      if (track == null || maxBitrate == null) return
      val parameters = sender.parameters
      val encoding = parameters.encodings.firstOrNull() ?: return
      encoding.maxBitrateBps = maxBitrate
      encoding.maxFramerate = 60
      sender.parameters = parameters
    } catch (_: Exception) {}
  }

  /** ScreenShare: the answering side takes the video slot of the offer as its own, and may send its screen there. */
  private fun takeScreenSlot() {
    if (screenSender != null) return
    val connection = connection ?: return
    try {
      for (transceiver in connection.transceivers) {
        if (transceiver.mediaType != livekit.org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO || transceiver.mid.isNullOrEmpty()) continue
        transceiver.direction = livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV
        screenSender = transceiver.sender
        return
      }
    } catch (_: Exception) {}
  }

  /** Sends a text over the peer-to-peer channel; false when the channel is not open. */
  fun send(text: String): Boolean {
    val channel = channel ?: return false
    return try {
      if (channel.state() != DataChannel.State.OPEN) false
      else channel.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
    } catch (_: Exception) { false }
  }

  // Offers and answers

  val signalingState: String get() = try { connection?.signalingState()?.name?.lowercase()?.replace('_', '-') ?: "closed" } catch (_: Exception) { "closed" }

  /** This phone's SDP as the connection holds it now (with the addresses gathered so far). */
  val localSdp: String get() = try { connection?.localDescription?.description ?: "" } catch (_: Exception) { "" }

  private inner class Heard(private val made: ((String?) -> Unit)? = null, private val taken: ((Boolean) -> Unit)? = null) : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) { val sdp = description?.description; main.post { made?.invoke(sdp) } }
    override fun onCreateFailure(error: String?) { main.post { made?.invoke(null) } }
    override fun onSetSuccess() { main.post { taken?.invoke(true) } }
    override fun onSetFailure(error: String?) { main.post { taken?.invoke(false) } }
  }

  /** A new offer; `iceRestart`: with new addresses for the same connection. null when it cannot be made. */
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

  private fun description(kind: String, sdp: String): SessionDescription =
    SessionDescription(when (kind) { "offer" -> SessionDescription.Type.OFFER; "answer" -> SessionDescription.Type.ANSWER; else -> SessionDescription.Type.ROLLBACK }, sdp)

  /** `kind`: "offer", "answer" or "rollback" (takes this phone's pending offer back). `done`: whether it was taken. */
  fun setLocal(kind: String, sdp: String, done: (Boolean) -> Unit) {
    val connection = connection ?: return done(false)
    try { connection.setLocalDescription(Heard(taken = done), description(kind, sdp)) } catch (_: Exception) { done(false) }
  }

  fun setRemote(kind: String, sdp: String, done: (Boolean) -> Unit) {
    val connection = connection ?: return done(false)
    // ScreenShare: an offer brings the video slot; the answer takes it as this phone's own.
    val taken: (Boolean) -> Unit = { fine -> if (fine && kind == "offer") takeScreenSlot(); done(fine) }
    try { connection.setRemoteDescription(Heard(taken = taken), description(kind, sdp)) } catch (_: Exception) { done(false) }
  }

  // The addresses (non-trickle ICE: they travel once, inside the offer or the answer)

  /** Calls back once with this phone's SDP when its addresses are inside, or after `timeout` ms with what there is.
   *  `fresh`: only a gathering that finishes from now on counts (after an ICE restart the connection still says
   *  «complete» from the round before). One wait at a time: a new one takes the place of the old. */
  fun whenGathered(fresh: Boolean, timeout: Long, done: (String) -> Unit) {
    cancelGathering()
    val complete = try { connection?.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE } catch (_: Exception) { false }
    if (!fresh && complete) return done(localSdp)
    gatherDone = done
    val timer = Runnable { gatheringSettled() }
    gatherTimer = timer
    main.postDelayed(timer, timeout)
  }

  fun cancelGathering() {
    gatherTimer?.let { main.removeCallbacks(it) }
    gatherTimer = null
    gatherDone = null
  }

  private fun gatheringSettled() {
    val done = gatherDone ?: return
    cancelGathering()
    done(localSdp)
  }

  // The link

  /** Caps what the microphone may send, bits per second; null lifts the cap. */
  fun capAudio(bitrate: Double?) {
    val sender = micSender ?: return
    try {
      val parameters = sender.parameters
      val encoding = parameters.encodings.firstOrNull() ?: return
      encoding.maxBitrateBps = bitrate?.toInt()
      sender.parameters = parameters
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

  /** Tells the state when it is not the one told last. Also asked by the engine's own beat, so a change is never missed. */
  fun tellState() {
    val connection = connection ?: return
    if (closed) return
    val state = try { connection.connectionState().name.lowercase() } catch (_: Exception) { return }
    if (state == lastState) return
    lastState = state
    onState?.invoke(state)
  }

  /** The person left, or this phone did: the connection is closed. Nothing is told after it. The shared
   *  microphone stays the room's (its track is not this connection's to release). */
  fun close() {
    if (closed) return
    closed = true
    cancelGathering()
    onState = null
    onMessage = null
    onChannelOpen = null
    onVideo = null // ScreenShare
    try { screenSender?.setTrack(null, false) } catch (_: Exception) {}
    screenSender = null
    val open = channel
    channel = null
    try { open?.unregisterObserver() } catch (_: Exception) {}
    try { open?.close() } catch (_: Exception) {}
    try { micSender?.setTrack(null, false) } catch (_: Exception) {}
    micSender = null
    try { connection?.dispose() } catch (_: Exception) {}
    connection = null
  }

  companion object {
    /** `iceServers`: the server's answer to `GET /calls/ice`. `initiator`: this phone walked in and calls the
     *  person who was already inside (it also opens the text channel). null when the connection cannot be made. */
    fun create(context: Context, iceServers: List<Map<String, Any?>>, microphone: RoomMicrophone, initiator: Boolean): RoomPeerMedia? {
      val media = RoomPeerMedia(microphone)
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
        val connection = CallMedia.factory(context.applicationContext).createPeerConnection(config, media.observer) ?: return null
        media.connection = connection
        // ScreenShare: as the reference, the newcomer reserves a video slot before the first offer (a screen that is
        // started or stopped only swaps its picture, nothing is negotiated again). The answering side takes the slot
        // the offer brings (`takeScreenSlot`).
        if (initiator) {
          media.screenSender = connection.addTransceiver(livekit.org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
            livekit.org.webrtc.RtpTransceiver.RtpTransceiverInit(livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV))?.sender
        }
        // The microphone's place is agreed now, but the sound goes in only once the connection is checked.
        val sender = connection.addTrack(microphone.track, listOf(microphone.streamId))
        sender?.setTrack(null, false)
        media.micSender = sender
        // ScreenShare: after the microphone, the slot of a shared computer's sound (the reference's second audio
        // section: a computer sends its sound there; this phone only listens to it).
        if (initiator) connection.addTransceiver(livekit.org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
          livekit.org.webrtc.RtpTransceiver.RtpTransceiverInit(livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
        if (initiator) {
          connection.createDataChannel("screen-control", DataChannel.Init())?.let { opened ->
            media.channel = opened
            opened.registerObserver(media.Listener(opened))
          }
        }
        return media
      } catch (_: Throwable) {
        media.close()
        return null
      }
    }
  }
}
