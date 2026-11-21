package com.linea.messenger.screenshare

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.linea.messenger.calls.CallMedia
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.FrameCryptor
import livekit.org.webrtc.FrameCryptorAlgorithm
import livekit.org.webrtc.FrameCryptorFactory
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm
import livekit.org.webrtc.FrameCryptorKeyProvider
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpSender
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.VideoTrack
import java.util.UUID

/** The keys of shared screens and the sealing of their frames: the reference's `NativeCipher` (communities/sfu/
 *  session.ts) on the FrameCryptor of the WebRTC build the app already links (io.github.webrtc-sdk, the classes
 *  `livekit.org.webrtc.FrameCryptor*`; iOS ScreenShare/SfuSession.swift, `ScreenFrameKeys`).
 *
 *  A frame through the server is AES-GCM with a fresh 96-bit IV, its first bytes left readable for the codec (10 of a
 *  VP8 key frame, 3 otherwise, 1 of an Opus frame) and authenticated; then the IV, its length (12) and the key's index
 *  0..15 («lk» frames, frameCrypto.ts). The AES-128 key is HKDF-SHA256(raw key, salt «INVIZENT screen frames v1», 128
 *  zero bytes) — the key provider with HKDF and this ratchet salt derives exactly that, so the computers' frames and the
 *  phones' frames are the same bytes. Raw keys reach this phone only over the peer-to-peer channels of connections that
 *  passed the end-to-end check (rooms/RoomVoice.kt); the server forwards frames it cannot open. */
class ScreenFrameKeys {
  companion object {
    const val SALT = "INVIZENT screen frames v1"
    const val RING = 16
    const val OWN = "self"
  }

  /** The same settings as the iOS app and the reference: shared-key mode off, ratchet window 0, no magic bytes, failure
   *  tolerance −1, a ring of 16, frames dropped while no key is ready, HKDF. */
  val provider: FrameCryptorKeyProvider = FrameCryptorFactory.createFrameCryptorKeyProvider(false, SALT.toByteArray(Charsets.UTF_8), 0, ByteArray(0), -1, RING, true, FrameCryptorKeyDerivationAlgorithm.HKDF)

  /** A key a person sent over their checked channel. A legacy-layout key (index 16 and up): such a sharer sends this
   *  phone a direct copy instead. */
  fun setPeerKey(peer: String, index: Int, raw: ByteArray) {
    if (index < 0 || index >= RING || peer == OWN || raw.size != 16) return
    provider.setKey(peer, index, raw)
  }

  fun setOwnKey(index: Int, raw: ByteArray) { provider.setKey(OWN, index, raw) }

  /** The cryptor that opens what one person sends (null when the build could not make one: nothing is shown then). */
  fun opener(context: Context, receiver: RtpReceiver, peer: String): FrameCryptor? = try {
    FrameCryptorFactory.createFrameCryptorForRtpReceiver(CallMedia.factory(context), receiver, peer, FrameCryptorAlgorithm.AES_GCM, provider)?.also { it.setEnabled(true) }?.takeIf { it.isEnabled }
  } catch (_: Throwable) { null }

  /** The cryptor that seals what this phone sends, with the key at `index`. */
  fun sealer(context: Context, sender: RtpSender, index: Int): FrameCryptor? = try {
    FrameCryptorFactory.createFrameCryptorForRtpSender(CallMedia.factory(context), sender, OWN, FrameCryptorAlgorithm.AES_GCM, provider)?.also { it.keyIndex = index; it.setEnabled(true) }?.takeIf { it.isEnabled }
  } catch (_: Throwable) { null }

  fun dispose() { try { provider.dispose() } catch (_: Throwable) {} }
}

/** The lines of one SDP, cut into its session part and its media sections (enough for what mediasoup needs). */
private class SdpText(sdp: String) {
  val session = ArrayList<String>()
  val media = ArrayList<ArrayList<String>>()

  init {
    for (raw in sdp.split("\n")) {
      val line = raw.removeSuffix("\r")
      if (line.isEmpty()) continue
      if (line.startsWith("m=")) media.add(arrayListOf(line)) else if (media.isEmpty()) session.add(line) else media.last().add(line)
    }
  }

  companion object {
    fun value(lines: List<String>, prefix: String): String? = lines.firstOrNull { it.startsWith(prefix) }?.substring(prefix.length)

    /** «a=fmtp:96 a=1;b=x» → {a: 1, b: "x"} (numbers as numbers, as sdp-transform reads them). */
    fun parameters(text: String): Map<String, Any> {
      val out = LinkedHashMap<String, Any>()
      for (part in text.split(";")) {
        val item = part.trim()
        val equal = item.indexOf('=')
        if (equal < 0) continue
        val key = item.substring(0, equal); val value = item.substring(equal + 1)
        out[key] = value.toIntOrNull() ?: value
      }
      return out
    }

    fun parametersText(parameters: Map<*, *>): String = parameters.keys.map { it.toString() }.sorted().joinToString(";") { key ->
      val value = parameters[key]
      "$key=" + if (value is Double && value == Math.rint(value)) value.toLong().toString() else (value?.toString() ?: "")
    }
  }

  fun section(mid: String): List<String>? = media.firstOrNull { value(it, "a=mid:") == mid }

  /** The DTLS fingerprint this phone offers («sha-256 AB:CD…»), media level first. */
  fun fingerprint(mid: String?): Pair<String, String>? {
    var text = mid?.let { wanted -> section(wanted)?.let { value(it, "a=fingerprint:") } }
    if (text == null) text = value(session, "a=fingerprint:")
    if (text == null) text = media.firstNotNullOfOrNull { value(it, "a=fingerprint:") }
    val words = text?.split(" ") ?: return null
    if (words.size != 2) return null
    return words[0].lowercase() to words[1]
  }
}

/** One transport to the server's SFU (mediasoup): one peer connection, ICE-lite on the server's side, this phone the DTLS
 *  client. The server's half of the SDP is written here from the server's parameters, as mediasoup-client does it
 *  (handlers/sdp/RemoteSdp.js, RemoteMediaSection.js). Main thread. */
private class SfuTransport private constructor(val id: String, val sending: Boolean, private val ufrag: String, private val pwd: String, private val candidates: List<String>, private val fingerprint: String) {
  class Section(var mid: String, var kind: String, var body: MutableList<String>, var payloads: String, var closed: Boolean = false)

  var connection: PeerConnection? = null
  var ready = false
  val sections = ArrayList<Section>()
  private var version = 0
  private val queue = ArrayDeque<((() -> Unit) -> Unit)>()
  private var running = false
  private val main = Handler(Looper.getMainLooper())

  companion object {
    fun create(context: Context, params: Map<*, *>, sending: Boolean): SfuTransport? {
      val id = params["id"] as? String ?: return null
      val ice = params["iceParameters"] as? Map<*, *> ?: return null
      val ufrag = ice["usernameFragment"] as? String ?: return null
      val pwd = ice["password"] as? String ?: return null
      val prints = (params["dtlsParameters"] as? Map<*, *>)?.get("fingerprints") as? List<*> ?: return null
      val last = prints.lastOrNull() as? Map<*, *> ?: return null
      val algorithm = last["algorithm"] as? String ?: return null
      val value = last["value"] as? String ?: return null
      val lines = ArrayList<String>()
      for (raw in (params["iceCandidates"] as? List<*>).orEmpty()) {
        val item = raw as? Map<*, *> ?: continue
        val foundation = item["foundation"] ?: continue
        val priority = (item["priority"] as? Number)?.toLong() ?: continue
        val port = (item["port"] as? Number)?.toInt() ?: continue
        val address = (item["address"] as? String) ?: (item["ip"] as? String) ?: continue
        val proto = item["protocol"] as? String ?: continue
        var line = "a=candidate:$foundation 1 $proto $priority $address $port typ ${item["type"] as? String ?: "host"}"
        (item["tcpType"] as? String)?.let { line += " tcptype $it" }
        lines.add(line)
      }
      val made = SfuTransport(id, sending, ufrag, pwd, lines, "$algorithm $value")
      val config = PeerConnection.RTCConfiguration(emptyList())
      config.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
      config.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
      config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      // Nothing to tell: the server is ICE-lite (it learns this phone's addresses from the checks themselves).
      val quiet = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(candidate: IceCandidate?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
      }
      made.connection = try { CallMedia.factory(context).createPeerConnection(config, quiet) } catch (_: Throwable) { null } ?: return null
      return made
    }
  }

  /** One negotiation at a time on this connection: `step` calls its argument when it is over. */
  fun serial(step: (() -> Unit) -> Unit) { queue.addLast(step); runNext() }

  private fun runNext() {
    if (running || queue.isEmpty()) return
    running = true
    val step = queue.removeFirst()
    step { main.post { running = false; runNext() } }
  }

  /** The server's half of the SDP: an offer (receiving) or an answer (sending). */
  fun remoteSdp(): String {
    version += 1
    val out = arrayListOf("v=0", "o=mediasoup-client 10000 $version IN IP4 0.0.0.0", "s=-", "t=0 0", "a=ice-lite", "a=fingerprint:$fingerprint", "a=msid-semantic: WMS *")
    out.add("a=group:BUNDLE " + sections.filter { !it.closed }.joinToString(" ") { it.mid })
    if (!sending) out.add("a=extmap-allow-mixed")
    out.add("a=ice-options:ice2")
    for (section in sections) {
      out.add("m=${section.kind} ${if (section.closed) 0 else 7} UDP/TLS/RTP/SAVPF ${section.payloads}")
      out.add("c=IN IP4 127.0.0.1")
      if (section.closed) { out.add("a=mid:${section.mid}"); out.add("a=inactive"); continue }
      out.addAll(section.body)
      out.add("a=setup:" + if (sending) "passive" else "actpass")
      out.add("a=mid:${section.mid}")
      out.add("a=ice-ufrag:$ufrag")
      out.add("a=ice-pwd:$pwd")
      out.addAll(candidates)
      out.add("a=end-of-candidates")
      out.add("a=ice-options:renomination")
      out.add("a=rtcp-mux")
      out.add("a=rtcp-rsize")
    }
    return out.joinToString("\r\n") + "\r\n"
  }

  fun close() {
    queue.clear()
    try { connection?.dispose() } catch (_: Throwable) {}
    connection = null
  }
}

/** Why a request to the SFU did not work, in the server's words. */
class SfuFailure(val words: String) : Exception(words)

/** Screen sharing through the server's SFU (server/src/sfu.js, mediasoup): the reference's `SfuSession`. The person
 *  sharing uploads one copy, every frame sealed before it leaves the phone; viewers open frames only with keys received
 *  over their checked peer-to-peer channels. The server never sees a picture.
 *
 *  Signalling: `{ type: 'sfu', id, op, … }` over the live line → `{ type: 'sfu.reply', id, ok, data | error }`;
 *  `sfu.producer` (somebody started sending), `sfu.closed` (what this phone received has stopped). Main thread. */
class SfuSession(private val context: Context, private val send: (Map<String, Any?>) -> Boolean) {
  /** A person's screen through the server (null: it ended). */
  var onRemote: ((String, VideoTrack?) -> Unit)? = null
  private val main = Handler(Looper.getMainLooper())
  private val keys = ScreenFrameKeys()
  private var nextId = 1
  private val pending = HashMap<Int, Pair<(Result<Map<String, Any?>>) -> Unit, Runnable>>()
  private var routerCaps: Map<String, Any?> = emptyMap()
  private var recv: SfuTransport? = null
  private var sendTransport: SfuTransport? = null
  private var sendSlot: RtpTransceiver? = null
  private var sealer: FrameCryptor? = null
  private var sendParameters: MutableMap<String, Any?>? = null
  private var producerId: String? = null
  private class Consumer(val peer: String, val kind: String, val mid: String, val cryptor: FrameCryptor)
  private val consumers = HashMap<String, Consumer>()
  private var closed = false
  private val streamId = UUID.randomUUID().toString().lowercase()

  // ---- Requests ----

  private fun request(op: String, payload: Map<String, Any?> = emptyMap(), done: (Result<Map<String, Any?>>) -> Unit) {
    val id = nextId++
    val timer = Runnable { pending.remove(id)?.first?.invoke(Result.failure(SfuFailure("Сервер не ответил."))) }
    pending[id] = done to timer
    main.postDelayed(timer, 15_000)
    val frame = LinkedHashMap(payload)
    frame["type"] = "sfu"; frame["id"] = id; frame["op"] = op
    if (!send(frame)) {
      main.removeCallbacks(timer)
      pending.remove(id)
      done(Result.failure(SfuFailure("Нет соединения с сервером.")))
    }
  }

  /** Live-line messages for this session. True when handled. */
  fun handle(data: Map<String, Any?>): Boolean {
    when (data["type"] as? String ?: return false) {
      "sfu.reply" -> {
        val id = (data["id"] as? Number)?.toInt() ?: return true
        val waiting = pending.remove(id) ?: return true
        main.removeCallbacks(waiting.second)
        if (data["ok"] == true) waiting.first(Result.success(@Suppress("UNCHECKED_CAST") (data["data"] as? Map<String, Any?> ?: emptyMap())))
        else waiting.first(Result.failure(SfuFailure(data["error"] as? String ?: "Ошибка сервера демонстрации.")))
        return true
      }
      "sfu.producer" -> {
        val peer = data["peer"] as? String; val producer = data["producerId"] as? String
        if (peer != null && producer != null) consume(peer, producer)
        return true
      }
      "sfu.closed" -> { (data["consumerId"] as? String)?.let { dropConsumer(it) }; return true }
    }
    return false
  }

  // ---- Start ----

  /** The server's codecs, the receiving transport, and whatever the others already send. `done`: whether it worked. */
  fun start(done: (Boolean) -> Unit) {
    request("caps") { result ->
      if (closed) return@request
      @Suppress("UNCHECKED_CAST") val caps = result.getOrNull()?.get("rtpCapabilities") as? Map<String, Any?> ?: return@request done(false)
      routerCaps = caps
      request("transport", mapOf("direction" to "recv")) { made ->
        if (closed) return@request
        val transport = made.getOrNull()?.let { SfuTransport.create(context, it, sending = false) } ?: return@request done(false)
        recv = transport
        request("producers") { list ->
          if (closed) return@request
          for (raw in (list.getOrNull()?.get("producers") as? List<*>).orEmpty()) {
            val item = raw as? Map<*, *> ?: continue
            val peer = item["peer"] as? String; val producer = item["producerId"] as? String
            if (peer != null && producer != null) consume(peer, producer)
          }
          done(true)
        }
      }
    }
  }

  /** What this phone can receive: the server's own codecs and the header extensions it sends (`getRecvRtpCapabilities`). */
  private val receiveCaps: Map<String, Any?>
    get() {
      val out = LinkedHashMap(routerCaps)
      out["headerExtensions"] = (routerCaps["headerExtensions"] as? List<*>).orEmpty().filter { item ->
        val direction = (item as? Map<*, *>)?.get("direction") as? String ?: "sendrecv"
        direction == "sendrecv" || direction == "sendonly"
      }
      return out
    }

  /** The header extensions the server takes from a sender of `kind` (`uri` set). */
  private fun sendableExtensions(kind: String): Set<String> {
    val out = HashSet<String>()
    for (raw in (routerCaps["headerExtensions"] as? List<*>).orEmpty()) {
      val item = raw as? Map<*, *> ?: continue
      if (item["kind"] != kind) continue
      val uri = item["uri"] as? String ?: continue
      val direction = item["direction"] as? String ?: "sendrecv"
      if (direction == "sendrecv" || direction == "recvonly") out.add(uri)
    }
    return out
  }

  private fun connect(transport: SfuTransport, sdp: SdpText, mid: String?, done: (Boolean) -> Unit) {
    if (transport.ready) return done(true)
    val print = sdp.fingerprint(mid) ?: return done(false)
    val dtls = mapOf("role" to "client", "fingerprints" to listOf(mapOf("algorithm" to print.first, "value" to print.second)))
    request("connect", mapOf("transportId" to transport.id, "dtlsParameters" to dtls)) { result ->
      if (result.isSuccess) { transport.ready = true; done(true) } else done(false)
    }
  }

  // ---- WebRTC's callbacks, on the main thread ----

  private fun observer(made: ((SessionDescription?) -> Unit)? = null, taken: ((Boolean) -> Unit)? = null) = object : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) { main.post { made?.invoke(description) } }
    override fun onCreateFailure(error: String?) { main.post { made?.invoke(null) } }
    override fun onSetSuccess() { main.post { taken?.invoke(true) } }
    override fun onSetFailure(error: String?) { main.post { taken?.invoke(false) } }
  }

  // ---- Sending ----

  /** Share: one upload to the server, every frame sealed with `raw` (its index 0..15 lets the viewers pick the key). The
   *  sealing cryptor is on the sender before anything is negotiated, so no frame can leave unsealed. */
  fun publish(track: VideoTrack, raw: ByteArray, keyIndex: Int, maxBitrate: Int, done: (Boolean) -> Unit) {
    if (closed) return done(false)
    keys.setOwnKey(keyIndex, raw)
    sendTransport?.let { return produce(it, track, keyIndex, maxBitrate, done) }
    request("transport", mapOf("direction" to "send")) { result ->
      if (closed) return@request done(false)
      val transport = result.getOrNull()?.let { SfuTransport.create(context, it, sending = true) } ?: return@request done(false)
      sendTransport = transport
      produce(transport, track, keyIndex, maxBitrate, done)
    }
  }

  private fun produce(transport: SfuTransport, track: VideoTrack, keyIndex: Int, maxBitrate: Int, done: (Boolean) -> Unit) {
    transport.serial step@{ finish ->
      val connection = transport.connection
      if (closed || connection == null) { done(false); return@step finish() }
      val fail: () -> Unit = {
        try { sendSlot?.sender?.setTrack(null, false) } catch (_: Throwable) {}
        done(false)
        finish()
      }
      // A first share that broke half way: the session no longer sends (the viewers get direct copies instead).
      if (sendSlot != null && sendParameters == null) return@step fail()
      // The slot made once is used again for every share (the server keeps at most two transports per person).
      val slot0 = sendSlot; val sealer0 = sealer; val parameters0 = sendParameters
      if (slot0 != null && sealer0 != null && parameters0 != null) {
        sealer0.keyIndex = keyIndex
        try { slot0.sender.setTrack(track, false) } catch (_: Throwable) {}
        cap(slot0.sender, maxBitrate)
        @Suppress("UNCHECKED_CAST") val encodings = (parameters0["encodings"] as? List<Map<String, Any?>>)?.map { LinkedHashMap(it) }
        if (!encodings.isNullOrEmpty()) { encodings[0]["maxBitrate"] = maxBitrate; parameters0["encodings"] = encodings }
        return@step askProduce(transport, parameters0, done, finish, fail)
      }
      val encoding = RtpParameters.Encoding(null, true, null).apply { maxBitrateBps = maxBitrate; maxFramerate = 60 }
      val slot = try { connection.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(streamId), listOf(encoding))) } catch (_: Throwable) { null } ?: return@step fail()
      // Sealed from the very first frame; without a cryptor nothing goes out.
      val made = keys.sealer(context, slot.sender, keyIndex)
      if (made == null) {
        try { slot.sender.setTrack(null, false); slot.direction = RtpTransceiver.RtpTransceiverDirection.INACTIVE } catch (_: Throwable) {}
        return@step fail()
      }
      sendSlot = slot
      sealer = made
      connection.createOffer(observer(made = { offer ->
        if (closed || offer == null) return@observer fail()
        connect(transport, SdpText(offer.description), null) { fine ->
          if (!fine || closed) return@connect fail()
          connection.setLocalDescription(observer(taken = taken@{ set ->
            val local = connection.localDescription
            if (closed || !set || local == null) return@taken fail()
            val built = sendingParameters(SdpText(local.description), slot.mid ?: "", maxBitrate) ?: return@taken fail()
            transport.sections.clear(); transport.sections.add(built.second)
            connection.setRemoteDescription(observer(taken = { answered ->
              if (closed || !answered) return@observer fail()
              cap(slot.sender, maxBitrate)
              sendParameters = built.first
              askProduce(transport, built.first, done, finish, fail)
            }), SessionDescription(SessionDescription.Type.ANSWER, transport.remoteSdp()))
          }), offer)
        }
      }), MediaConstraints())
    }
  }

  private fun askProduce(transport: SfuTransport, parameters: Map<String, Any?>, done: (Boolean) -> Unit, finish: () -> Unit, fail: () -> Unit) {
    request("produce", mapOf("transportId" to transport.id, "kind" to "video", "rtpParameters" to parameters, "source" to "screen")) { result ->
      val id = result.getOrNull()?.get("producerId") as? String
      if (closed || id == null) return@request fail()
      producerId = id
      done(true)
      finish()
    }
  }

  private fun cap(sender: RtpSender, maxBitrate: Int) {
    try {
      val parameters = sender.parameters
      val encoding = parameters.encodings.firstOrNull() ?: return
      encoding.maxBitrateBps = maxBitrate
      encoding.maxFramerate = 60
      sender.parameters = parameters
    } catch (_: Throwable) {}
  }

  /** The producer's RTP parameters read from this phone's offer (VP8 and its retransmission, the header extensions the
   *  server takes, the SSRCs and the CNAME — `getSendingRtpParameters`, `getRtpEncodings`), and the server's answer for
   *  the section (`RemoteAnswerMediaSection`, with `videoGoogleStartBitrate: 2000`). */
  private fun sendingParameters(sdp: SdpText, mid: String, maxBitrate: Int): Pair<MutableMap<String, Any?>, SfuTransport.Section>? {
    if (mid.isEmpty()) return null
    val lines = sdp.section(mid) ?: return null
    val rtpmap = HashMap<Int, String>(); val fmtp = HashMap<Int, Map<String, Any>>()
    val feedback = HashMap<Int, MutableList<Pair<String, String>>>()
    val extensions = ArrayList<Pair<Int, String>>()
    val ssrcs = ArrayList<Long>(); val groups = ArrayList<Pair<Long, Long>>()
    var cname = ""
    for (line in lines) {
      when {
        line.startsWith("a=rtpmap:") -> { val space = line.indexOf(' '); line.substring(9, maxOf(9, space)).toIntOrNull()?.let { if (space > 0) rtpmap[it] = line.substring(space + 1) } }
        line.startsWith("a=fmtp:") -> { val space = line.indexOf(' '); line.substring(7, maxOf(7, space)).toIntOrNull()?.let { if (space > 0) fmtp[it] = SdpText.parameters(line.substring(space + 1)) } }
        line.startsWith("a=rtcp-fb:") -> {
          val words = line.substring(10).split(" ")
          val pt = words.getOrNull(0)?.toIntOrNull()
          if (words.size >= 2 && pt != null) feedback.getOrPut(pt) { ArrayList() }.add(words[1] to (words.getOrNull(2) ?: ""))
        }
        line.startsWith("a=extmap:") -> {
          val words = line.substring(9).split(" ")
          val id = words.getOrNull(0)?.split("/")?.firstOrNull()?.toIntOrNull()
          if (words.size >= 2 && id != null) extensions.add(id to words[1])
        }
        line.startsWith("a=ssrc-group:FID ") -> { val words = line.substring(17).split(" ").mapNotNull { it.toLongOrNull() }; if (words.size == 2) groups.add(words[0] to words[1]) }
        line.startsWith("a=ssrc:") -> {
          val rest = line.substring(7); val space = rest.indexOf(' ')
          val ssrc = (if (space > 0) rest.substring(0, space) else rest).toLongOrNull()
          if (ssrc != null && ssrc !in ssrcs) ssrcs.add(ssrc)
          if (space > 0 && rest.substring(space + 1).startsWith("cname:")) cname = rest.substring(space + 1 + 6)
        }
      }
    }
    val vp8 = rtpmap.keys.sorted().firstOrNull { rtpmap[it]?.lowercase() == "vp8/90000" } ?: return null
    val rtx = rtpmap.keys.sorted().firstOrNull { rtpmap[it]?.lowercase() == "rtx/90000" && fmtp[it]?.get("apt") == vp8 }
    val ssrc = groups.firstOrNull { it.first in ssrcs }?.first ?: ssrcs.firstOrNull() ?: return null
    val rtxSsrc = groups.firstOrNull { it.first == ssrc }?.second
    // The server's VP8 feedback (nack, nack pli, ccm fir, goog-remb, transport-cc): only what both sides know.
    val known = setOf("nack", "nack pli", "ccm fir", "goog-remb", "transport-cc")
    var vp8Feedback = (feedback[vp8] ?: emptyList<Pair<String, String>>()).filter { (it.first + " " + it.second).trim() in known }
    val takes = sendableExtensions("video")
    val chosen = extensions.filter { it.second in takes && it.second != "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension" }
    val codecs = ArrayList<Map<String, Any?>>()
    codecs.add(mapOf("mimeType" to "video/VP8", "payloadType" to vp8, "clockRate" to 90000, "parameters" to (fmtp[vp8] ?: emptyMap<String, Any>()), "rtcpFeedback" to vp8Feedback.map { mapOf("type" to it.first, "parameter" to it.second) }))
    if (rtx != null) codecs.add(mapOf("mimeType" to "video/rtx", "payloadType" to rtx, "clockRate" to 90000, "parameters" to mapOf("apt" to vp8), "rtcpFeedback" to emptyList<Any>()))
    val encoding = linkedMapOf<String, Any?>("ssrc" to ssrc, "maxBitrate" to maxBitrate, "maxFramerate" to 60)
    if (rtxSsrc != null && rtx != null) encoding["rtx"] = mapOf("ssrc" to rtxSsrc)
    val parameters = linkedMapOf<String, Any?>(
      "mid" to mid,
      "codecs" to codecs,
      "headerExtensions" to chosen.map { mapOf("uri" to it.second, "id" to it.first, "encrypt" to false, "parameters" to emptyMap<String, Any>()) },
      "encodings" to listOf(encoding),
      "rtcp" to mapOf("cname" to cname, "reducedSize" to true),
    )
    // The answer: transport-cc when there is its extension, REMB otherwise (`getSendingRemoteRtpParameters`).
    val uris = chosen.map { it.second }.toSet()
    vp8Feedback = when {
      "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" in uris -> vp8Feedback.filter { it.first != "goog-remb" }
      "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time" in uris -> vp8Feedback.filter { it.first != "transport-cc" }
      else -> vp8Feedback.filter { it.first != "transport-cc" && it.first != "goog-remb" }
    }
    val body = arrayListOf("a=rtpmap:$vp8 VP8/90000")
    if (rtx != null) body.add("a=rtpmap:$rtx rtx/90000")
    body.add("a=fmtp:$vp8 x-google-start-bitrate=2000")
    if (rtx != null) body.add("a=fmtp:$rtx apt=$vp8")
    for (fb in vp8Feedback) body.add("a=rtcp-fb:$vp8 ${fb.first}" + if (fb.second.isEmpty()) "" else " " + fb.second)
    for (ext in chosen) body.add("a=extmap:${ext.first} ${ext.second}")
    body.add("a=recvonly")
    return parameters to SfuTransport.Section(mid, "video", body, if (rtx != null) "$vp8 $rtx" else "$vp8")
  }

  /** Stops sending: the picture leaves the slot and the server forgets the producer (the slot stays for the next share). */
  fun unpublish() {
    try { sendSlot?.sender?.setTrack(null, false) } catch (_: Throwable) {}
    val id = producerId ?: return
    producerId = null
    request("close", mapOf("producerId" to id)) { }
  }

  // ---- Receiving ----

  /** A key a person sent over their own checked peer-to-peer channel. */
  fun setPeerKey(peer: String, index: Int, raw: ByteArray) = keys.setPeerKey(peer, index, raw)

  private fun consume(peer: String, producer: String) {
    val transport = recv ?: return
    if (closed) return
    request("consume", mapOf("transportId" to transport.id, "producerId" to producer, "rtpCapabilities" to receiveCaps)) { result ->
      val body = result.getOrNull() ?: return@request
      if (closed) return@request
      val consumer = body["consumerId"] as? String ?: return@request
      val kind = body["kind"] as? String ?: return@request
      val parameters = body["rtpParameters"] as? Map<*, *> ?: return@request
      receive(transport, peer, consumer, kind, parameters)
    }
  }

  /** The server's offer gets one more section for the consumer (`RemoteOfferMediaSection`); this phone answers it. */
  private fun receive(transport: SfuTransport, peer: String, consumer: String, kind: String, parameters: Map<*, *>) {
    transport.serial step@{ finish ->
      val connection = transport.connection
      if (closed || connection == null) return@step finish()
      val mid = parameters["mid"] as? String ?: transport.sections.size.toString()
      val section = offerSection(mid, kind, parameters, "consumer-$consumer") ?: return@step finish()
      val reuse = transport.sections.indexOfFirst { it.closed && it.kind == kind }
      if (reuse >= 0) transport.sections[reuse] = section else transport.sections.add(section)
      val fail: () -> Unit = { closeSection(transport, mid); finish() }
      connection.setRemoteDescription(observer(taken = { set ->
        if (closed || !set) return@observer fail()
        connection.createAnswer(observer(made = { made ->
          if (closed || made == null) return@observer fail()
          // A computer's sound in stereo when the sender says so (`applyCodecParameters`).
          val sdp = stereoAnswer(made.description, mid, parameters)
          connect(transport, SdpText(sdp), mid) { fine ->
            if (!fine || closed) return@connect fail()
            connection.setLocalDescription(observer(taken = taken@{ local ->
              val slot = connection.transceivers.firstOrNull { it.mid == mid }
              if (closed || !local || slot == null) return@taken fail()
              // Never shown without the opener: frames that cannot be opened are dropped.
              val opener = keys.opener(context, slot.receiver, peer) ?: return@taken fail()
              consumers[consumer] = Consumer(peer, kind, mid, opener)
              finish()
              request("resume", mapOf("consumerId" to consumer)) { }
              if (kind == "video") (slot.receiver.track() as? VideoTrack)?.let { onRemote?.invoke(peer, it) }
            }), SessionDescription(SessionDescription.Type.ANSWER, sdp))
          }
        }), MediaConstraints())
      }), SessionDescription(SessionDescription.Type.OFFER, transport.remoteSdp()))
    }
  }

  private fun number(value: Any?): Long? = (value as? Number)?.toLong()

  private fun offerSection(mid: String, kind: String, parameters: Map<*, *>, trackId: String): SfuTransport.Section? {
    val codecs = (parameters["codecs"] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }
    if (codecs.isEmpty()) return null
    val encoding = (parameters["encodings"] as? List<*>)?.firstOrNull() as? Map<*, *> ?: return null
    val cname = (parameters["rtcp"] as? Map<*, *>)?.get("cname") as? String ?: ""
    val body = ArrayList<String>(); val payloads = ArrayList<String>()
    for (codec in codecs) {
      val pt = number(codec["payloadType"]) ?: continue
      val mime = codec["mimeType"] as? String ?: continue
      val rate = number(codec["clockRate"]) ?: continue
      val slash = mime.indexOf('/')
      if (slash < 0) continue
      val channels = number(codec["channels"]) ?: 1
      body.add("a=rtpmap:$pt ${mime.substring(slash + 1)}/$rate" + if (channels > 1) "/$channels" else "")
      payloads.add(pt.toString())
    }
    for (codec in codecs) {
      val pt = number(codec["payloadType"]) ?: continue
      val params = codec["parameters"] as? Map<*, *> ?: emptyMap<Any, Any>()
      if (params.isNotEmpty()) body.add("a=fmtp:$pt " + SdpText.parametersText(params))
      for (raw in (codec["rtcpFeedback"] as? List<*>).orEmpty()) {
        val fb = raw as? Map<*, *> ?: continue
        val type = fb["type"] as? String ?: continue
        val parameter = fb["parameter"] as? String ?: ""
        body.add("a=rtcp-fb:$pt $type" + if (parameter.isEmpty()) "" else " $parameter")
      }
    }
    for (raw in (parameters["headerExtensions"] as? List<*>).orEmpty()) {
      val ext = raw as? Map<*, *> ?: continue
      val uri = ext["uri"] as? String ?: continue
      val id = number(ext["id"]) ?: continue
      body.add("a=extmap:$id $uri")
    }
    body.add("a=extmap-allow-mixed")
    body.add("a=msid:$cname $trackId")
    body.add("a=sendonly")
    number(encoding["ssrc"])?.let { ssrc ->
      if (cname.isNotEmpty()) body.add("a=ssrc:$ssrc cname:$cname")
      number((encoding["rtx"] as? Map<*, *>)?.get("ssrc"))?.let { rtx ->
        if (cname.isNotEmpty()) body.add("a=ssrc:$rtx cname:$cname")
        body.add("a=ssrc-group:FID $ssrc $rtx")
      }
    }
    return SfuTransport.Section(mid, kind, body, payloads.joinToString(" "))
  }

  private fun stereoAnswer(sdp: String, mid: String, parameters: Map<*, *>): String {
    val opus = (parameters["codecs"] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }.firstOrNull { (it["mimeType"] as? String)?.lowercase() == "audio/opus" } ?: return sdp
    val pt = number(opus["payloadType"]) ?: return sdp
    if (number((opus["parameters"] as? Map<*, *>)?.get("sprop-stereo")) != 1L) return sdp
    val eol = if (sdp.contains("\r\n")) "\r\n" else "\n"
    val lines = sdp.split(eol).toMutableList()
    // The section of this consumer: from its «m=» line to the next one.
    var start = -1; var end = lines.size; var current = -1
    for ((index, line) in lines.withIndex()) {
      if (line.startsWith("m=")) { if (start >= 0) { end = index; break }; current = index }
      if (line == "a=mid:$mid" && current >= 0) start = current
    }
    if (start < 0) return sdp
    val at = (start until end).firstOrNull { lines[it].startsWith("a=fmtp:$pt ") }
    if (at != null) { if (!lines[at].contains("stereo=1")) lines[at] = lines[at] + ";stereo=1" }
    else (start until end).firstOrNull { lines[it].startsWith("a=rtpmap:$pt ") }?.let { lines.add(it + 1, "a=fmtp:$pt stereo=1") }
    return lines.joinToString(eol)
  }

  private fun closeSection(transport: SfuTransport, mid: String) {
    val index = transport.sections.indexOfFirst { it.mid == mid }
    if (index < 0) return
    // The first section carries the shared transport: it is only made inactive, never closed.
    if (index == 0) {
      val last = transport.sections[0].body.indexOfLast { it == "a=sendonly" }
      if (last >= 0) transport.sections[0].body[last] = "a=inactive"
    } else transport.sections[index].closed = true
  }

  private fun dropConsumer(id: String) {
    val item = consumers.remove(id) ?: return
    val transport = recv ?: return
    try { item.cryptor.setEnabled(false) } catch (_: Throwable) {}
    transport.serial step@{ finish ->
      val connection = transport.connection
      if (closed || connection == null) return@step finish()
      closeSection(transport, item.mid)
      connection.setRemoteDescription(observer(taken = { set ->
        if (!set) return@observer finish()
        connection.createAnswer(observer(made = { made ->
          if (made == null) return@observer finish()
          connection.setLocalDescription(observer(taken = { finish() }), made)
        }), MediaConstraints())
      }), SessionDescription(SessionDescription.Type.OFFER, transport.remoteSdp()))
    }
    if (item.kind == "video" && consumers.values.none { it.peer == item.peer && it.kind == "video" }) onRemote?.invoke(item.peer, null)
  }

  /** Somebody left: their picture goes (their keys are replaced at the next share; the provider goes with the session). */
  fun forget(peer: String) { for ((id, item) in consumers.toList()) if (item.peer == peer) dropConsumer(id) }

  fun close() {
    closed = true
    for ((done, timer) in pending.values) { main.removeCallbacks(timer); done(Result.failure(SfuFailure("closed"))) }
    pending.clear()
    for (item in consumers.values) try { item.cryptor.setEnabled(false) } catch (_: Throwable) {}
    consumers.clear()
    try { sealer?.setEnabled(false) } catch (_: Throwable) {}
    sealer = null
    try { sendSlot?.sender?.setTrack(null, false) } catch (_: Throwable) {}
    sendSlot = null
    recv?.close(); sendTransport?.close()
    recv = null; sendTransport = null
    onRemote = null
  }
}

