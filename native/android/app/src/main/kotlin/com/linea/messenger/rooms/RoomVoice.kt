package com.linea.messenger.rooms

import android.app.Activity
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.calls.CallAudio
import com.linea.messenger.calls.CallNetwork
import com.linea.messenger.calls.CallRules
import com.linea.messenger.calls.Calls
import com.linea.messenger.calls.RoomMicrophone
import com.linea.messenger.calls.RoomPeerMedia
import com.linea.messenger.calls.callIceServers
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import java.lang.ref.WeakReference

/** Somebody this phone is connected to inside the room: `peer` is the id the server gave that person's connection
 *  (one person may be inside from two devices), `connected` — the voice is flowing. */
data class RoomVoicePeer(val peer: String, val userId: String, val muted: Boolean, val connected: Boolean)

/** The room this phone is inside, as the screens show it (the reference's `VoiceState` for a room). */
data class RoomVoiceState(
  val roomId: String,
  val name: String,
  /** "connecting" or "connected". */
  val status: String,
  val muted: Boolean = false,
  /** The sound is on the loudspeaker (false: the earpiece, or headphones when they are connected). */
  val speaker: Boolean,
  val peers: List<RoomVoicePeer> = emptyList(),
  val error: String = "",
  /** The worst link among the people this phone is connected to: "good", "weak" or "bad". */
  val link: String = "good",
)

/** The voice of a room: the reference's communities/voice.ts, as far as a room uses it.
 *
 *  - A room is a full mesh, up to twelve people: this phone has its own connection (WebRTC, DTLS-SRTP) to every
 *    person inside; the sound goes phone to phone, a relay (TURN) only forwards ciphertext. The server introduces
 *    the devices: it relays the offers and answers (`voice.signal`) over the live line, and nothing else.
 *  - The newcomer calls everyone who is already inside. The offer and the answer travel once, with the addresses
 *    already in them (non-trickle ICE).
 *  - The offers and answers go through the server in the clear, so the server could put itself in the middle.
 *    Every connection is therefore checked end to end: each side sends the other's very device a short note
 *    encrypted with Signal (`voice.auth`) naming the two DTLS fingerprints it sees. Until the other side's note
 *    matches the connection this phone really made, its microphone is not put into that connection and nothing
 *    that arrives over it is played; a wrong note, or none in twenty seconds, and the connection is closed.
 *  - A checked connection that drops is restarted (ICE restart) over the same signalling; the restart must carry
 *    the very fingerprints that were checked.
 *  - After the live line reconnects the server no longer knows this phone is inside: it walks in again.
 *
 *  The rules are the shared core's (RoomRules, CallRules); the media is calls/RoomMedia.kt; this object keeps the
 *  order. Nothing from a closed app: a room is entered while the app is open (it goes on while the app is in the
 *  background — the live line is held, as in a call). Main thread only. */
object RoomVoice {
  /** Posted on the main thread whenever the room this phone is inside (or the fact that it is in one) changed. */
  val changed = Live.Signal<Unit>()

  var state: RoomVoiceState? = null
    private set(value) { field = value; changed.post(Unit) }
  /** Whether this phone is inside a room now (music asks it: the phone's sound is then the room's own). */
  val inside: Boolean get() = state != null
  /** Why the last attempt to walk in ended, in the server's words; empty when it did not fail. */
  var lastError = ""
    private set
  /** The room the last failed attempt was for (its screen shows `lastError`; another room's does not). */
  var lastErrorRoom = ""
    private set

  /** Music for everyone (RoomMusic.kt): a text of a checked person's peer-to-peer channel, and a person whose
   *  channel has just become usable. */
  var onPeerText: ((String, String) -> Unit)? = null
  var onPeerReady: ((String) -> Unit)? = null
  /** This phone is about to leave the room (its connections are still open): the last word to the others. */
  var onLeaving: (() -> Unit)? = null

  private class Auth(val local: String, val remote: String, val media: RoomPeerMedia)
  private class Info(val userId: String, val device: String?)
  private class LinkEntry(var link: Map<String, Any?>? = null, var timer: Runnable? = null, var pendingAt: Double = 0.0)
  private class Grade(var grade: String = "good", var calm: Int = 0, var sample: Map<String, Any?>? = null)

  private val main = Handler(Looper.getMainLooper())
  private var messenger: Messenger? = null
  private var app: Context? = null
  private var window = WeakReference<Activity>(null)
  private var microphone: RoomMicrophone? = null
  private var iceServers: List<Map<String, Any?>> = emptyList()
  private var ownDevice = ""
  private var selfPeer: String? = null
  private var joining = 0
  private val connections = LinkedHashMap<String, RoomPeerMedia>()
  private val peerInfo = HashMap<String, Info>()
  private val verified = HashSet<String>()
  private val authSdp = HashMap<String, Auth>()
  private val pendingNotes = HashMap<String, Map<String, Any?>>()
  private val authTimers = HashMap<String, Runnable>()
  // Automatic reconnection of a checked connection: the link's state (the core's), its timer, when this phone last
  // sent a restart offer.
  private val links = HashMap<String, LinkEntry>()
  // The link's grade per person: the last sample of its statistics, the grade and how long it has been calm.
  private val grades = HashMap<String, Grade>()
  private var linkTimer: Runnable? = null
  private var beat: Runnable? = null
  private var network: CallNetwork? = null
  private var watching = false
  /** The debug build's samples (`--es roomsdemo`): the screens without an account, a server or any media. */
  private var demo = false
  private var demoSpeaking: Set<String> = emptySet()
  val isDemo: Boolean get() = demo

  private val heard: (Map<String, Any?>) -> Unit = { event(it) }
  private val callWatch: (Unit) -> Unit = { callMoved() }

  private fun after(ms: Long, work: () -> Unit): Runnable = Runnable { work() }.also { main.postDelayed(it, ms) }
  private fun cancel(timer: Runnable?) { if (timer != null) main.removeCallbacks(timer) }

  /** The window the system's question about the microphone is asked in; begins to hear the live line. */
  fun attach(activity: Activity?) {
    if (activity != null) { window = WeakReference(activity); app = activity.applicationContext }
    if (watching) return
    watching = true
    Live.roomEvent.watch(heard)
    Calls.changed.watch(callWatch)
  }

  private val gatherTimeout: Long get() = (Core.map(Core.view("callRules", emptyList()))?.get("gatherTimeoutMs") as? Number)?.toLong() ?: 3_000L

  /** Whether the phone's sound goes to something worn or plugged in (anything but its own loudspeaker and earpiece). */
  fun headphones(context: Context?): Boolean {
    val system = context?.applicationContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
    return try {
      system.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || it.type == 26 /* TYPE_BLE_HEADSET */
      }
    } catch (_: Exception) { false }
  }

  private fun patch(change: (RoomVoiceState) -> RoomVoiceState) {
    val current = state ?: return
    state = change(current)
  }

  private fun send(frame: Map<String, Any?>): Boolean = messenger?.live?.send(frame) ?: false

  // Walking in and out

  /** Walks into the room: the microphone opens and the others hear this phone once each connection is checked.
   *  `done` gets null, or the words that say why not. The microphone is asked for here, the first time. */
  fun join(messenger: Messenger, roomId: String, name: String, done: (String?) -> Unit) {
    if (state?.roomId == roomId) return done(null)
    // A one-to-one call and a room share the phone's microphone and its sound: one at a time.
    if (Calls.call?.isOver == false) return done("Сначала заверши звонок.")
    if (state != null) leave()
    joining += 1
    val attempt = joining
    lastError = ""
    CallAudio.allow(window.get(), video = false) asked@{ words ->
      if (joining != attempt) return@asked done(null)
      if (words != null) return@asked done(words.replace("чтобы звонить", "чтобы зайти в комнату"))
      messenger.callIceServers { servers ->
        if (joining != attempt) return@callIceServers done(null)
        // Without the server's list: the public address finder alone, as the reference does.
        iceServers = servers ?: CallRules.publicIce
        // This phone's encryption device: the others seal their notes for exactly this device.
        messenger.crypto.run({ crypto ->
          crypto.callNow("initialize")
          crypto.callNow("deviceId").getOrNull() as? String
        }) { device ->
          if (joining != attempt) return@run done(null)
          if (device.isNullOrEmpty()) return@run done("Шифрование ещё не готово. Попробуй ещё раз.")
          if (Calls.call?.isOver == false) return@run done("Сначала заверши звонок.")
          begin(messenger, roomId, name, device, done)
        }
      }
    }
  }

  private fun begin(messenger: Messenger, roomId: String, name: String, device: String, done: (String?) -> Unit) {
    val context = app ?: return done("Не удалось зайти в комнату.")
    val opened = RoomMicrophone.open(context) ?: return done("Не удалось зайти в комнату.")
    this.messenger = messenger
    ownDevice = device
    CallAudio.start(context, video = false)
    // A room sounds on the loudspeaker, as in the reference — unless headphones are on.
    val speaker = !headphones(context)
    CallAudio.route(if (speaker) true else null, video = false)
    microphone = opened
    val watch = CallNetwork()
    // Wi-Fi ↔ mobile or a new address: ICE is restarted with every checked person at once.
    watch.onChange = { for ((peer, media) in connections.toList()) feedLink(peer, media, mapOf("kind" to "network")) }
    watch.start(context)
    network = watch
    messenger.live.heldByCall = true
    state = RoomVoiceState(roomId, name, status = "connecting", speaker = speaker)
    val links = object : Runnable { override fun run() { checkLinks(); main.postDelayed(this, RoomRules.linkPoll) } }
    linkTimer = links
    main.postDelayed(links, RoomRules.linkPoll)
    val ticks = object : Runnable { override fun run() { for (media in connections.values.toList()) media.tellState(); main.postDelayed(this, 1000) } }
    beat = ticks
    main.postDelayed(ticks, 1000)
    if (!send(mapOf("type" to "voice.join", "roomId" to roomId, "device" to device))) {
      cleanup()
      return done("Нет соединения с сервером.")
    }
    done(null)
  }

  /** Walks out: the others are told, every connection is closed, the microphone released. */
  fun leave() {
    if (state == null) return
    if (demo) {
      demo = false
      state = null
      return
    }
    send(mapOf("type" to "voice.leave"))
    cleanup()
  }

  /** The account was left: nothing of it goes on. */
  fun stop() {
    joining += 1
    leave()
    messenger = null
    lastError = ""
  }

  private fun cleanup() {
    if (state != null) onLeaving?.invoke()
    for (media in connections.values) media.close()
    connections.clear()
    for (timer in authTimers.values) cancel(timer)
    authTimers.clear()
    for (entry in links.values) cancel(entry.timer)
    links.clear()
    grades.clear()
    verified.clear()
    authSdp.clear()
    pendingNotes.clear()
    peerInfo.clear()
    selfPeer = null
    cancel(linkTimer); linkTimer = null
    cancel(beat); beat = null
    network?.stop()
    network = null
    microphone?.release()
    microphone = null
    // A one-to-one call that has just begun owns the phone's sound and the line from here on.
    if (Calls.call?.isOver != false) {
      CallAudio.stop()
      messenger?.live?.heldByCall = false
    }
    state = null
  }

  /** A one-to-one call began (placed here, or ringing): the room is left — the two cannot share the microphone. */
  private fun callMoved() {
    if (state == null || demo) return
    if (Calls.call?.isOver == false) {
      joining += 1
      leave()
    } else {
      // A call that ended took its hold off the line: the room's own hold is put back.
      messenger?.live?.heldByCall = true
    }
  }

  // The controls

  fun toggleMute() {
    val current = state ?: return
    val muted = !current.muted
    microphone?.set(!muted)
    send(mapOf("type" to "voice.mute", "muted" to muted))
    patch { it.copy(muted = muted) }
  }

  /** «Звук на динамике» ↔ «Звук в трубке» (with headphones on, the second one is the headphones). */
  fun toggleSpeaker() {
    val current = state ?: return
    val speaker = !current.speaker
    if (!demo) CallAudio.route(if (speaker) true else null, video = false)
    patch { it.copy(speaker = speaker) }
  }

  /** The notice of a refused connection was read. */
  fun clearError() {
    val current = state ?: return
    if (current.error.isEmpty()) return
    patch { it.copy(error = "") }
  }

  /** Who is heard right now: the ids of the people whose incoming sound is above a whisper, and this account's
   *  own when its microphone is. Read from the connections' own statistics. */
  fun speaking(me: String, done: (Set<String>) -> Unit) {
    if (demo) return done(demoSpeaking)
    val current = state ?: return done(emptySet())
    if (connections.isEmpty()) return done(emptySet())
    val level = RoomRules.speakingLevel
    val out = HashSet<String>()
    var waiting = connections.size
    for ((peer, media) in connections.toList()) {
      val userId = current.peers.firstOrNull { it.peer == peer }?.userId
      media.statistics { reports ->
        for (report in reports) {
          val heard = (report["audioLevel"] as? Number)?.toDouble() ?: continue
          if (heard <= level) continue
          val audio = report["kind"] as? String == "audio" || report["mediaType"] as? String == "audio"
          val type = report["type"] as? String ?: continue
          if (!audio) continue
          if (type == "inbound-rtp") { if (userId != null) out.add(userId) }
          else if (type == "media-source" && !current.muted) out.add(me)
        }
        waiting -= 1
        if (waiting == 0) done(out)
      }
    }
  }

  /** Music for everyone: tells every checked person whose channel is open. False when the text is not sent to anyone. */
  fun sendToPeers(text: String): Boolean {
    var sent = false
    for ((peer, media) in connections.toList()) if (peer in verified && media.send(text)) sent = true
    return sent
  }

  /** The person behind a connection's id, among those inside. */
  fun userIdOfPeer(peer: String): String? = state?.peers?.firstOrNull { it.peer == peer }?.userId

  // What the live line says

  private fun event(data: Map<String, Any?>) {
    val type = data["type"] as? String ?: return
    if (demo) return
    val current = state ?: return
    val roomId = current.roomId
    val here = data["channelId"] as? String == roomId
    when (type) {
      "voice.joined" -> {
        if (!here) return
        selfPeer = data["self"] as? String
        val peers = ArrayList<RoomVoicePeer>()
        for (item in (data["peers"] as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }) {
          val peer = item["peer"] as? String ?: continue
          val userId = item["userId"] as? String ?: continue
          peerInfo[peer] = Info(userId, item["device"] as? String)
          peers.add(RoomVoicePeer(peer, userId, item["muted"] as? Boolean ?: false, connected = false))
        }
        patch { it.copy(status = "connected", peers = peers) }
        // The newcomer calls everyone already in the room.
        for (item in peers) call(item.peer)
      }
      "voice.signal" -> {
        if (!here) return
        val from = data["from"] as? String ?: return
        val payload = Core.map(data["data"] as? Map<*, *>) ?: return
        val kind = payload["kind"] as? String ?: return
        val sdp = payload["sdp"] as? String ?: return
        if (kind == "offer") {
          if (acceptRestart(from, sdp)) return
          offered(from, data["userId"] as? String ?: "", data["device"] as? String, sdp)
        } else if (kind == "answer") answered(from, sdp)
      }
      "voice.auth" -> {
        if (!here) return
        val from = data["from"] as? String ?: return
        val note = Core.map(data["note"] as? Map<*, *>) ?: return
        if (authSdp[from] != null) verifyNote(from, note) else pendingNotes[from] = note
      }
      "voice.left" -> (data["peer"] as? String)?.let { drop(it) }
      "voice.state" -> {
        if (!here) return
        val members = (data["members"] as? List<*>)?.mapNotNull { Core.map(it as? Map<*, *>) } ?: return
        // The microphones of everyone in the room.
        val muted = HashMap<String, Boolean>()
        for (item in members) (item["userId"] as? String)?.let { muted[it] = item["muted"] as? Boolean ?: false }
        patch { voice -> voice.copy(peers = voice.peers.map { peer -> muted[peer.userId]?.let { peer.copy(muted = it) } ?: peer }) }
      }
      // No longer a member, or the room is gone.
      "voice.kicked" -> if (here) cleanup()
      "error" -> {
        // The server refused the way in (the room is full, no longer a member).
        if (current.status == "connecting") {
          lastError = data["error"] as? String ?: ""
          lastErrorRoom = roomId
          cleanup()
        }
      }
      // The live line reconnected: the server forgot this phone, it walks in again (after the line's own handling
      // of «ready», so the line already counts as up).
      "ready" -> main.post { rejoin(roomId) }
    }
  }

  private fun rejoin(roomId: String) {
    val current = state ?: return
    if (current.roomId != roomId) return
    for (peer in connections.keys.toList()) drop(peer)
    selfPeer = null
    patch { it.copy(status = "connecting", peers = emptyList()) }
    send(mapOf("type" to "voice.join", "roomId" to roomId, "muted" to current.muted, "device" to ownDevice))
  }

  // Connections

  private fun mark(sdp: String): String = CallRules.words("callMarkRestart", listOf(sdp)) ?: sdp
  private fun strip(sdp: String): String = CallRules.words("callStripRestart", listOf(sdp)) ?: sdp

  /** A new connection to a person; whatever was known about the old one is forgotten. */
  private fun connectionFor(peer: String, initiator: Boolean): RoomPeerMedia? {
    unverify(peer)
    connections.remove(peer)?.close()
    val microphone = microphone ?: return null
    val context = app ?: return null
    val media = RoomPeerMedia.create(context, iceServers, microphone, initiator) ?: return null
    media.onState = { state ->
      if (connections[peer] === media) {
        feedLink(peer, media, mapOf("kind" to "state", "state" to state))
        if (state == "connected") peerUpdate(peer, connected = true)
        else if (state == "failed" || state == "closed") peerUpdate(peer, connected = false)
      }
    }
    // Only from a person whose connection passed the check.
    media.onMessage = { text -> if (connections[peer] === media && peer in verified) onPeerText?.invoke(peer, text) }
    media.onChannelOpen = { if (connections[peer] === media) onPeerReady?.invoke(peer) }
    connections[peer] = media
    return media
  }

  private fun peerUpdate(peer: String, connected: Boolean) {
    val current = state ?: return
    val known = current.peers.firstOrNull { it.peer == peer } ?: return
    if (known.connected == connected) return
    patch { voice -> voice.copy(peers = voice.peers.map { if (it.peer == peer) it.copy(connected = connected) else it }) }
  }

  private fun drop(peer: String) {
    unverify(peer)
    peerInfo.remove(peer)
    grades.remove(peer)
    connections.remove(peer)?.close()
    val current = state ?: return
    if (current.peers.none { it.peer == peer }) return
    patch { voice -> voice.copy(peers = voice.peers.filter { it.peer != peer }) }
  }

  /** This phone walked in: it calls a person who is already inside. */
  private fun call(peer: String) {
    val media = connectionFor(peer, initiator = true) ?: return drop(peer)
    media.makeOffer(iceRestart = false) { sdp ->
      if (connections[peer] !== media) return@makeOffer
      if (sdp == null) return@makeOffer drop(peer)
      media.setLocal("offer", sdp) { fine ->
        if (connections[peer] !== media) return@setLocal
        if (!fine) return@setLocal drop(peer)
        media.whenGathered(fresh = false, timeout = gatherTimeout) { local ->
          if (connections[peer] === media) send(mapOf("type" to "voice.signal", "to" to peer, "data" to mapOf("kind" to "offer", "sdp" to mark(local))))
        }
      }
    }
  }

  /** A person walked in and calls this phone. */
  private fun offered(from: String, userId: String, device: String?, sdp: String) {
    peerInfo[from] = Info(userId, device)
    val current = state
    if (current != null && current.peers.none { it.peer == from }) {
      patch { it.copy(peers = it.peers + RoomVoicePeer(from, userId, muted = false, connected = false)) }
    }
    val media = connectionFor(from, initiator = false) ?: return drop(from)
    media.setRemote("offer", strip(sdp)) { taken ->
      if (connections[from] !== media) return@setRemote
      if (!taken) return@setRemote drop(from)
      media.makeAnswer { answer ->
        if (connections[from] !== media) return@makeAnswer
        if (answer == null) return@makeAnswer drop(from)
        media.setLocal("answer", answer) { fine ->
          if (connections[from] !== media) return@setLocal
          if (!fine) return@setLocal drop(from)
          media.whenGathered(fresh = false, timeout = gatherTimeout) { local ->
            if (connections[from] !== media) return@whenGathered
            send(mapOf("type" to "voice.signal", "to" to from, "data" to mapOf("kind" to "answer", "sdp" to mark(local))))
            startAuth(from, media, local, sdp)
          }
        }
      }
    }
  }

  /** The answer to this phone's offer: the first one, or the answer to an ICE restart of a checked connection. */
  private fun answered(from: String, sdp: String) {
    val media = connections[from] ?: return
    if (media.signalingState != "have-local-offer") return
    val auth = authSdp[from]
    if (from in verified && auth != null) {
      // The same fingerprints, or the connection is refused.
      if (!CallRules.flag("callSameFingerprints", listOf(sdp, auth.remote))) return refuse(from)
      // Not taken: the next attempt is on the timer.
      media.setRemote("answer", strip(sdp)) { }
      return
    }
    media.setRemote("answer", strip(sdp)) { fine ->
      if (connections[from] !== media) return@setRemote
      if (!fine) return@setRemote drop(from)
      startAuth(from, media, media.localSdp, sdp)
    }
  }

  // The end-to-end check of a connection

  private fun unverify(peer: String) {
    links.remove(peer)?.let { cancel(it.timer) }
    verified.remove(peer)
    authSdp.remove(peer)
    pendingNotes.remove(peer)
    cancel(authTimers.remove(peer))
  }

  /** The check failed, or never came: the connection to this person is closed and the room says so. */
  private fun refuse(peer: String) {
    if (state == null) return
    drop(peer)
    patch { it.copy(error = RoomRules.refused) }
  }

  /** Both SDPs of the connection are known: this phone sends its note (sealed for the person's very device) and
   *  checks theirs. Runs alongside the connection's own set-up, so it adds no wait before the voice. */
  private fun startAuth(peer: String, media: RoomPeerMedia, localSdp: String, remoteSdp: String) {
    if (connections[peer] !== media) return
    val current = state ?: return
    val own = selfPeer ?: return
    authSdp[peer] = Auth(localSdp, remoteSdp, media)
    cancel(authTimers[peer])
    authTimers[peer] = after(RoomRules.authTimeout) {
      if (connections[peer] === media && peer !in verified) refuse(peer)
    }
    // Without the person's device (an app without the check, or the server hid it) the timer refuses it.
    val info = peerInfo[peer] ?: return
    val device = info.device ?: return
    val text = Core.view("roomAuthText", listOf(current.roomId, own, peer, localSdp, remoteSdp)) as? String
    // An SDP without a fingerprint: there is nothing to vouch for.
    if (text == null) return refuse(peer)
    seal(peer, media, info.userId, device, text, again = true)
    pendingNotes.remove(peer)?.let { verifyNote(peer, it) }
  }

  private fun seal(peer: String, media: RoomPeerMedia, userId: String, device: String, text: String, again: Boolean) {
    val messenger = messenger ?: return
    messenger.crypto.call("sealNote", listOf(userId, device, text)) { result ->
      if (connections[peer] !== media) return@call
      val note = Core.map(result.getOrNull() as? Map<*, *>)
      if (note != null) {
        send(mapOf("type" to "voice.auth", "to" to peer, "note" to note))
        return@call
      }
      // Once more in a second (the person's keys may not have been read yet), then the connection is refused.
      if (!again) return@call refuse(peer)
      after(1000) { if (connections[peer] === media) seal(peer, media, userId, device, text, again = false) }
    }
  }

  private fun verifyNote(peer: String, note: Map<String, Any?>) {
    val auth = authSdp[peer] ?: return
    val info = peerInfo[peer] ?: return
    val current = state ?: return
    val own = selfPeer ?: return
    val messenger = messenger ?: return
    if (peer in verified) return
    val media = auth.media
    // The note must come from the device the server named for this person.
    val device = info.device
    if (device == null || note["senderDeviceId"] as? String != device) {
      if (connections[peer] === media) refuse(peer)
      return
    }
    val expected = mapOf("channelId" to current.roomId, "self" to own, "peer" to peer, "localSdp" to auth.local, "remoteSdp" to auth.remote)
    messenger.crypto.call("openNote", listOf(info.userId, note)) { result ->
      if (connections[peer] !== media || peer in verified) return@call
      val text = result.getOrNull() as? String
      val fine = text != null && Core.view("roomCheckAuth", listOf(text, expected)) as? Boolean == true
      if (!fine) return@call refuse(peer)
      verified.add(peer)
      cancel(authTimers.remove(peer))
      // The connection is proven end to end: sound both ways.
      media.setAudible(true)
      media.setMicrophone(live = true)
      onPeerReady?.invoke(peer)
    }
  }

  // Automatic reconnection of a checked connection

  private fun feedLink(peer: String, media: RoomPeerMedia, input: Map<String, Any?>) {
    if (state == null) return
    val own = selfPeer ?: return
    if (connections[peer] !== media || peer !in verified) return
    // The side with the smaller id restarts first; the other waits a little longer, so usually one offer is in flight.
    val polite = Core.view("roomRestartOfferer", listOf(own, peer)) as? Boolean != true
    val entry = links.getOrPut(peer) { LinkEntry() }
    val step = CallRules.fields("callLinkNext", listOf(entry.link, input, CallRules.nowMs, polite))
    val next = Core.map(step["link"] as? Map<*, *>) ?: return
    cancel(entry.timer)
    entry.timer = null
    entry.link = next
    (step["wakeAt"] as? Number)?.toDouble()?.let { wakeAt ->
      entry.timer = after(maxOf(0.0, wakeAt - CallRules.nowMs).toLong()) { feedLink(peer, media, mapOf("kind" to "timer")) }
    }
    // The window ran out: shown as not connected, still in the room.
    if (step["end"] == true) peerUpdate(peer, connected = false)
    if (step["restart"] == true) restart(peer, media)
  }

  private fun restart(peer: String, media: RoomPeerMedia) {
    val auth = authSdp[peer] ?: return
    val entry = links[peer] ?: return
    if (!CallRules.flag("callRestartCapable", listOf(auth.remote))) return
    val signaling = media.signalingState
    if (signaling != "stable" && signaling != "have-local-offer") return
    entry.pendingAt = CallRules.nowMs
    // The wait is set up before the offer: after an ICE restart the gathering starts over.
    media.whenGathered(fresh = true, timeout = gatherTimeout) { local ->
      if (connections[peer] === media) send(mapOf("type" to "voice.signal", "to" to peer, "data" to mapOf("kind" to "offer", "sdp" to mark(local))))
    }
    media.makeOffer(iceRestart = true) { sdp ->
      // Not made: the next attempt is on the timer.
      if (sdp == null) return@makeOffer media.cancelGathering()
      media.setLocal("offer", sdp) { fine -> if (!fine) media.cancelGathering() }
    }
  }

  /** An offer for a checked connection with the very fingerprints it was checked with is an ICE restart of it:
   *  answered on that connection. True when the offer was one (anything else is a new connection and goes through
   *  the whole check again). */
  private fun acceptRestart(from: String, sdp: String): Boolean {
    val media = connections[from] ?: return false
    val auth = authSdp[from] ?: return false
    val own = selfPeer ?: return false
    if (from !in verified || !CallRules.flag("callSameFingerprints", listOf(sdp, auth.remote))) return false
    val polite = Core.view("roomRestartOfferer", listOf(own, from)) as? Boolean != true
    val input = mapOf<String, Any?>("gen" to 1, "lastRemoteGen" to 0, "signalingState" to media.signalingState, "polite" to polite, "fingerprintsMatch" to true,
      "pendingAgeMs" to CallRules.nowMs - (links[from]?.pendingAt ?: 0.0))
    val decision = CallRules.words("callRemoteRestart", listOf(input)) ?: "answer"
    // Both restarted at once and this phone's offer wins: the other side answers it.
    if (decision == "ignore-glare") return true
    val localBefore = auth.local
    val answer = {
      if (connections[from] === media) media.setRemote("offer", strip(sdp)) { fine ->
        // Not taken: they try again.
        if (fine && connections[from] === media) {
          media.whenGathered(fresh = true, timeout = gatherTimeout) { local ->
            if (connections[from] === media) {
              // This phone's certificate did not change either; if it somehow did, the check no longer holds.
              if (!CallRules.flag("callSameFingerprints", listOf(local, localBefore))) refuse(from)
              else send(mapOf("type" to "voice.signal", "to" to from, "data" to mapOf("kind" to "answer", "sdp" to mark(local))))
            }
          }
          media.makeAnswer { made ->
            if (made == null) return@makeAnswer media.cancelGathering()
            media.setLocal("answer", made) { taken -> if (!taken) media.cancelGathering() }
          }
        }
      }
    }
    if (decision == "rollback-and-answer") {
      media.cancelGathering()
      media.setLocal("rollback", "") { answer() }
    } else answer()
    return true
  }

  // The link's grade

  /** Every few seconds each person's link is read from the connection itself: when packets to or from someone are
   *  lost or late, the voice sent to that person is made lighter at once; it comes back step by step. */
  private fun checkLinks() {
    if (state == null) return
    for ((peer, media) in connections.toList()) {
      media.statistics { reports ->
        if (connections[peer] !== media) return@statistics
        val known = grades.getOrPut(peer) { Grade() }
        val answer = CallRules.fields("callLink", listOf(reports, known.sample, CallRules.nowMs))
        val reading = Core.map(answer["link"] as? Map<*, *>) ?: return@statistics
        known.sample = Core.map(answer["sample"] as? Map<*, *>)
        val step = CallRules.fields("callGrade", listOf(reading, known.grade, known.calm))
        known.calm = (step["calm"] as? Number)?.toInt() ?: 0
        val grade = step["grade"] as? String
        if (grade != null && grade != known.grade) {
          known.grade = grade
          media.capAudio((CallRules.fields("callCaps", listOf(CallRules.tier, grade))["audio"] as? Number)?.toDouble())
        }
        tellWorstLink()
      }
    }
  }

  private fun tellWorstLink() {
    var worst = "good"
    for ((peer, known) in grades) {
      if (connections[peer] == null) continue
      if (known.grade == "bad" || (known.grade == "weak" && worst == "good")) worst = known.grade
    }
    val current = state ?: return
    if (current.link != worst) patch { it.copy(link = worst) }
  }

  // The debug build's samples

  /** A room this phone is «inside» without a server or any media (`--es roomsdemo`). */
  fun showDemo(roomId: String, name: String, peers: List<RoomVoicePeer>, muted: Boolean, speaking: Set<String>) {
    demo = true
    demoSpeaking = speaking
    state = RoomVoiceState(roomId, name, status = "connected", muted = muted, speaker = true, peers = peers)
  }
}
