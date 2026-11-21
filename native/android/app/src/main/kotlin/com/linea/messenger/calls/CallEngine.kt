package com.linea.messenger.calls

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.net.Live
import com.linea.messenger.people.Person
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.people.personProfile
import java.lang.ref.WeakReference
import java.util.UUID

/** One-to-one calls of the signed-in account: the reference's CallProvider.tsx, step for step.
 *
 *    outgoing:  requesting («Запрос…») → ringing («Вызов…») → connecting («Соединение…») → active (the clock) → ended
 *    incoming:  incoming («Входящий звонок») → connecting → active → ended
 *
 *  - The offer and the answer each travel once, with the phone's addresses already inside (non-trickle ICE), as
 *    end-to-end encrypted messages of the chat (CallSignals.kt).
 *  - A second call while one is on is answered «busy»; an offer older than a minute never rings; nobody answers
 *    for a minute — «Нет ответа» on the caller's side, «Пропущенный звонок» here.
 *  - Once the media is up a drop is not the end: «Восстановление связи…», ICE restarts numbered so a late one is
 *    ignored (if both sides restart at once the caller's offer wins), «Связь потеряна» after 30 seconds.
 *  - Offline, an outgoing call waits for the connection («Ожидание сети…») and ends with «Нет соединения» and
 *    «Повторить» if it does not come.
 *
 *  The rules themselves are the shared core's (CallRules); the media is CallMedia; this object keeps the order.
 *  There is no system call screen and no call notification from a closed app: a call lives while the app is
 *  open. Main thread only. */
object Calls {
  /** Posted on the main thread whenever the call (or the fact that there is one) changed. */
  val changed = Live.Signal<Unit>()

  var call: CallState? = null
    private set(value) { field = value; changed.post(Unit) }
  /** The media of the call that is on, for the screen's pictures. */
  var media: CallMedia? = null
    private set
  /** The link's last reading (the diagnostics under the status), null before the first one. */
  var linkReading: Map<String, Any?>? = null
    private set

  private val main = Handler(Looper.getMainLooper())
  private var messenger: Messenger? = null
  private var signals: CallSignals? = null
  private var app: Context? = null
  /** The window the system's questions (the microphone, the camera) are asked in. */
  private var window = WeakReference<Activity>(null)
  private val network = CallNetwork().also {
    it.onOnline = { networkMoved() }
    it.onChange = { feedLink(mapOf("kind" to "network")) }
  }
  /** The ids of calls this phone has placed, rung for or refused. */
  private val seen = HashSet<String>()
  /** The steps already heard (a step is looked for again after every reconnection of the line, see CallSignals). */
  private val heardSteps = LinkedHashSet<String>()
  private var ringTimer: Runnable? = null
  private var reachTimer: Runnable? = null
  private var linkTimer: Runnable? = null
  private var beat: Runnable? = null
  private var beats = 0
  /** Which ringback plays for an outgoing call, and whether the server has said how far the call got. */
  private var ringTone = ""
  private var reachKnown = false
  /** The servers of the last call, for when fresh ones cannot be asked for. */
  private var lastIce: Pair<Long, List<Map<String, Any?>>>? = null
  /** Whether a relay is configured for this call, and whether its address has been gathered. */
  private var wantRelay = false
  private var relayFound = false
  private val gatherWaits = ArrayList<GatherWait>()
  private val networkWaiters = ArrayList<Pair<String, (Boolean) -> Unit>>()
  // Automatic reconnection: the link's state (null: up), our last restart number, the one we wait an answer
  // for, and the newest one the other side sent.
  private var link: Map<String, Any?>? = null
  private var restartGen = 0
  private var pendingGen: Int? = null
  private var pendingAt = 0.0
  private var lastRemoteGen = 0
  private var restarting = false
  private var linkSample: Map<String, Any?>? = null
  private var calm = 0

  /** The debug build's samples (`--es calldemo`, src/debug CallsDemo.kt): the screens without an account, a
   *  server or any media. What a sample call becomes when «Ответить» or «Повторить» is pressed is theirs to say. */
  interface Samples {
    fun answered(call: CallState): CallState
    fun again()
  }
  private var samples: Samples? = null
  /** Whether the call on screen is a sample (its pictures are drawn, not filmed). */
  val isDemo: Boolean get() = samples != null

  private val fallbackIce = listOf(mapOf<String, Any?>("urls" to listOf("stun:stun.l.google.com:19302")))

  private fun after(ms: Long, work: () -> Unit): Runnable = Runnable { work() }.also { main.postDelayed(it, ms) }
  private fun cancel(timer: Runnable?) { if (timer != null) main.removeCallbacks(timer) }
  private fun tap(strong: Boolean = false) {
    try { window.get()?.window?.decorView?.performHapticFeedback(if (strong) HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Exception) {}
  }

  // The account

  /** The account whose calls these are (null: the debug build's shell without one). */
  fun start(activity: Activity?, messenger: Messenger?) {
    if (activity != null) { window = WeakReference(activity); app = activity.applicationContext }
    if (this.messenger === messenger && (signals != null || messenger == null)) return
    stop()
    this.messenger = messenger
    if (messenger == null) return
    app?.let { network.start(it) }
    val heard = CallSignals(messenger)
    heard.onSignal = { message -> signalArrived(message) }
    heard.onReach = { chatId, reach -> reached(chatId, reach) }
    heard.onLine = { networkMoved() }
    signals = heard
  }

  /** The account was left: a call that is on ends here (the other side is told while the session still lives). */
  fun stop() {
    val current = call
    if (current != null && !current.isOver) hangup()
    cleanup()
    samples = null
    if (call != null) call = null
    signals?.close()
    signals = null
    messenger = null
  }

  /** An account's work on this device ends (`Messenger.close`): its calls end with it. */
  fun left(account: Messenger) { if (messenger === account) stop() }

  /** "online", "waiting" («Ожидание сети…») or "connecting" («Соединение…»): the road the signalling takes. */
  val signalNetwork: String
    get() {
      if (isDemo) return "online"
      return CallRules.words("callSignalNetwork", listOf(messenger?.live?.line ?: "offline", network.online)) ?: "waiting"
    }

  /** Where a person's picture is asked for (empty: they have none). */
  fun pictureAddress(person: Person): String = messenger?.personAvatarAddress(person.avatarId) ?: ""

  private fun patch(change: (CallState) -> CallState) {
    val current = call ?: return
    call = change(current)
  }

  /** Whether the call with this id is the one that is on (a call that has just ended is not: what was started
   *  for it stops where it is). */
  private fun isCurrent(id: String): Boolean = call?.let { it.id == id && !it.isOver } ?: false

  private fun send(current: CallState, action: Map<String, Any?>) {
    messenger?.sendCallSignal(current.chatId, current.peer.id, action)
  }

  private fun marked(sdp: String): String = CallRules.words("callMarkRestart", listOf(sdp)) ?: sdp
  private fun stripped(sdp: String): String = CallRules.words("callStripRestart", listOf(sdp)) ?: sdp

  // Placing a call

  /** «Позвонить» / «Видеозвонок». With a call already on, that call comes back to the screen instead. */
  fun place(chatId: String, peer: Person, video: Boolean) {
    if (call != null) return restore()
    val messenger = messenger ?: return
    val id = UUID.randomUUID().toString().lowercase()
    seen.add(id)
    try { MusicPlayer.shared.stop() } catch (_: Exception) {}
    tap(strong = true)
    samples = null
    call = CallState(id, chatId, peer, incoming = false, video = video, status = "requesting", speaker = video)
    began()
    // The header knows only the name: the picture and the colour come from the profile.
    messenger.personProfile(peer.id) { result ->
      val profile = result.getOrNull()
      if (profile != null && isCurrent(id)) patch { it.copy(peer = profile.person) }
    }
    // Offline: wait for the connection first (the screen says «Ожидание сети…»); nothing has been sent yet.
    waitForNetwork(id) { online ->
      if (!isCurrent(id)) return@waitForNetwork
      if (!online) return@waitForNetwork finish(CallRules.noConnectionText, null, retry = true)
      // The callee decides who may ring them (Настройки → Конфиденциальность → Звонки).
      messenger.callAllowed(peer.id, incoming = false) allowed@{ allowed ->
        if (!isCurrent(id)) return@allowed
        if (allowed == false) return@allowed finish("Этот человек ограничил, кто может ему звонить", null)
        CallAudio.allow(window.get(), video) asked@{ refusal ->
          if (!isCurrent(id)) return@asked
          if (refusal != null) return@asked finish(refusal, null)
          app?.let { CallAudio.start(it, video) }
          prepare(id, video) prepared@{ made ->
            if (!isCurrent(id)) return@prepared
            if (made == null) return@prepared finish("Не удалось начать звонок", null)
            offer(made, restart = false) offered@{ sdp ->
              if (!isCurrent(id)) return@offered
              if (sdp == null) return@offered finish("Не удалось начать звонок", null)
              ring(id, video, sdp)
            }
          }
        }
      }
    }
  }

  /** The offer is ready: it goes out, and the call rings. */
  private fun ring(id: String, video: Boolean, sdp: String) {
    // The connection dropped while the offer was being prepared: an offer queued now would ring much later
    // (or never), so wait again and end with «Нет соединения» if it does not come back.
    waitForNetwork(id) { online ->
      val current = call
      if (current == null || current.id != id || current.isOver) return@waitForNetwork
      if (!online) return@waitForNetwork finish(CallRules.noConnectionText, null, retry = true)
      send(current, mapOf("type" to "call", "call" to id, "step" to "offer", "video" to video, "sdp" to marked(sdp)))
      patch { it.copy(status = "ringing") }
      // The first ringback: the call is on its way. The server then says how far it got (`call.reach`) and
      // the ringing one takes over. A server that says nothing gets the ringing tone after 3 s.
      ringTone = "connecting"
      reachKnown = false
      app?.let { CallSounds.play(it, "connecting") }
      cancel(reachTimer)
      reachTimer = after(3000) {
        if (isCurrent(id) && call?.status == "ringing" && ringTone == "connecting" && !reachKnown) {
          ringTone = "outgoing"
          app?.let { CallSounds.play(it, "outgoing") }
        }
      }
      // No answer in time: «Нет ответа» — or «Нет соединения» with «Повторить» when the connection is down.
      cancel(ringTimer)
      ringTimer = after(CallRules.ringTimeout) {
        if (isCurrent(id) && call?.status == "ringing") {
          val expiry = CallRules.fields("callRingExpiry", listOf(signalNetwork))
          finish(expiry["text"] as? String ?: "Нет ответа", "missed", retry = expiry["retry"] as? Boolean ?: false)
        }
      }
    }
  }

  private fun reached(chatId: String, reach: String) {
    val current = call ?: return
    if (current.incoming || current.status != "ringing" || current.chatId != chatId) return
    reachKnown = true
    // Reached (the app is connected, or a notification service took the call): the ringing tone. Not reached:
    // the «on its way» beeps go on.
    if ((reach == "online" || reach == "push") && ringTone != "outgoing") {
      ringTone = "outgoing"
      app?.let { CallSounds.play(it, "outgoing") }
    }
  }

  // The connection

  /** Asks for the call's servers and makes the connection with the microphone (and the camera). */
  private fun prepare(id: String, video: Boolean, done: (CallMedia?) -> Unit) {
    iceServers(0) { servers ->
      if (!isCurrent(id)) return@iceServers
      wantRelay = CallRules.flag("callHasRelay", listOf(servers))
      relayFound = false
      val made = app?.let { CallMedia.create(it, servers, video) } ?: return@iceServers done(null)
      made.onCandidate = { line -> if (CallRules.flag("callIsRelayCandidate", listOf(line))) relayFound = true }
      made.onGathering = { checkGathering() }
      made.onState = { state -> if (media === made) connectionMoved(state) }
      made.onRemoteVideo = { patch { it.copy(remoteVideo = true) } }
      resetLink()
      media = made
      patch { it.copy(localVideo = made.hasCamera) }
      done(made)
    }
  }

  /** Without the relay's address a call between two mobile networks cannot connect, so its request is not given
   *  up at the first failure: one more try, then the servers of the last call (the relay's password lasts 6
   *  hours), then the public address finder alone. */
  private fun iceServers(attempt: Int, done: (List<Map<String, Any?>>) -> Unit) {
    val messenger = messenger ?: return done(fallbackIce)
    messenger.callIceServers { servers ->
      if (servers != null) {
        lastIce = Pair(System.currentTimeMillis(), servers)
        return@callIceServers done(servers)
      }
      if (attempt == 0) { after(400) { iceServers(1, done) }; return@callIceServers }
      done(iceChoice(null, lastIce, System.currentTimeMillis(), CallRules.iceReuse))
    }
  }

  /** The servers a call uses: the fresh ones; without them those of the last call while they may be used again;
   *  else the public address finder alone. */
  fun iceChoice(fresh: List<Map<String, Any?>>?, kept: Pair<Long, List<Map<String, Any?>>>?, nowMs: Long, reuseMs: Long): List<Map<String, Any?>> {
    if (fresh != null) return fresh
    if (kept != null && nowMs - kept.first < reuseMs) return kept.second
    return fallbackIce
  }

  /** Our SDP, with economy voice on slow links: the other phone sends us less, and our own audio is capped. */
  private fun setLocal(made: CallMedia, kind: String, sdp: String, done: (Boolean) -> Unit) {
    val lean = CallRules.words("callEconomySdp", listOf(sdp, CallRules.tier)) ?: sdp
    made.setLocal(kind, lean) { fine ->
      if (fine) (CallRules.fields("callCaps", listOf(CallRules.tier, "good"))["send"] as? Number)?.let { made.cap("audio", it.toDouble()) }
      done(fine)
    }
  }

  /** Makes an offer, sets it and waits until the addresses are inside. null: it could not be made. */
  private fun offer(made: CallMedia, restart: Boolean, done: (String?) -> Unit) {
    val wait = if (restart) gatherAgain(made) { sdp -> done(sdp) } else null
    made.makeOffer(restart) { sdp ->
      if (sdp == null) { wait?.cancel(); return@makeOffer done(null) }
      setLocal(made, "offer", sdp) { fine ->
        if (!fine) { wait?.cancel(); return@setLocal done(null) }
        if (!restart) gather(made) { own -> done(own) }
      }
    }
  }

  /** Takes the other side's offer, answers it and waits until the addresses are inside. */
  private fun answer(made: CallMedia, offer: String, again: Boolean, done: (String?) -> Unit) {
    made.setRemote("offer", offer) { taken ->
      if (!taken) return@setRemote done(null)
      // After an ICE restart the gathering starts over: the wait is set up before our answer is.
      val wait = if (again) gatherAgain(made) { sdp -> done(sdp) } else null
      made.makeAnswer { sdp ->
        if (sdp == null) { wait?.cancel(); return@makeAnswer done(null) }
        setLocal(made, "answer", sdp) { fine ->
          if (!fine) { wait?.cancel(); return@setLocal done(null) }
          if (!again) gather(made) { own -> done(own) }
        }
      }
    }
  }

  // Non-trickle ICE

  /** One wait for the addresses to be inside the SDP (the core's `callGatherDone`: at once when gathering is
   *  complete; after 3 s if the relay's address is there or none is configured; never later than 10 s).
   *  `fresh`: «complete» counts only from now on (after an ICE restart the state still says so from the last round). */
  private class GatherWait(val media: CallMedia, val fresh: Boolean, val done: (String) -> Unit) {
    val started = System.currentTimeMillis()
    /** The gathering was seen under way after this wait began. */
    var moved = false
    var settled = false
    fun cancel() { settled = true }
  }

  private fun gather(made: CallMedia, done: (String) -> Unit): GatherWait {
    val wait = GatherWait(made, fresh = false, done = done)
    gatherWaits.add(wait)
    checkGathering()
    return wait
  }

  private fun gatherAgain(made: CallMedia, done: (String) -> Unit): GatherWait {
    relayFound = false
    val wait = GatherWait(made, fresh = true, done = done)
    gatherWaits.add(wait)
    return wait
  }

  /** Looked at on every event of the gathering and four times a second by the call's own beat. */
  private fun checkGathering() {
    for (wait in gatherWaits.toList()) {
      if (wait.settled) continue
      val made = wait.media
      if (made !== media) { wait.settled = true; continue }
      val finished = made.gatheringComplete
      if (!finished) wait.moved = true
      val elapsed = (System.currentTimeMillis() - wait.started).toDouble()
      val complete = if (wait.fresh) wait.moved && finished else finished
      if (!CallRules.flag("callGatherDone", listOf(complete, relayFound, wantRelay, elapsed))) continue
      wait.settled = true
      wait.done(made.localSdp)
    }
    gatherWaits.removeAll { it.settled }
  }

  // An incoming call

  /** The name a step is remembered by, so that the same message is acted on once; null when it has none. */
  fun stepKey(message: Map<String, Any?>): String? {
    val id = (message["id"] as? Number)?.toLong()
    if (id != null && id > 0) return "id:$id"
    val clientId = message["clientId"] as? String ?: return null
    return (message["senderId"] as? String ?: "") + ":" + clientId
  }

  /** A decrypted message of the other side that carries a call's step. */
  private fun signalArrived(message: Map<String, Any?>) {
    val action = Core.map(Core.map(message["meta"])?.get("action")) ?: return
    if (action["type"] as? String != "call") return
    val callId = action["call"] as? String ?: return
    val step = action["step"] as? String ?: return
    val chatId = message["chatId"] as? String ?: return
    val sdp = action["sdp"] as? String
    val gen = (action["gen"] as? Number)?.toInt()
    val video = action["video"] as? Boolean ?: false
    // The line looks into a chat again after every reconnection: a step that was already acted on is not a new one.
    stepKey(message)?.let { key ->
      if (!heardSteps.add(key)) return
      if (heardSteps.size > 400) heardSteps.remove(heardSteps.first())
    }
    val current = call

    if (step == "offer" && current != null && current.id == callId && current.status != "incoming" && sdp != null) {
      // Mid-call change (the other side turned the camera on): answer the new offer on the same connection.
      val made = media ?: return
      if (video && !current.video) patch { it.copy(video = true) }
      answer(made, stripped(sdp), again = false) { own ->
        val now = call
        if (own != null && now != null && now.id == callId && !now.isOver) send(now, mapOf("type" to "call", "call" to callId, "step" to "answer", "sdp" to marked(own)))
      }
      return
    }
    if (step == "offer") {
      if (sdp == null) return
      val senderId = message["senderId"] as? String ?: return
      val created = message["createdAt"] as? String ?: return
      if (!CallRules.flag("callOfferFresh", listOf(created, CallRules.nowMs, seen.toList(), callId))) return
      seen.add(callId)
      val messenger = messenger ?: return
      messenger.callPeer(chatId) { peer ->
        if (peer == null || this.messenger !== messenger) return@callPeer
        // A modified client could skip the server check; this phone still never rings for a caller it must not.
        messenger.callAllowed(senderId, incoming = true) { allowed ->
          if (this.messenger !== messenger) return@callAllowed
          if (allowed == false) messenger.sendCallSignal(chatId, peer.id, CallRules.end(callId, video, incoming = true, startedAt = null, reason = "declined"))
          else rings(chatId, peer, callId, video, sdp)
        }
      }
      return
    }

    if (current == null || current.id != callId) return
    // A call that has just ended here hears nothing more (its last words stay on the screen for a moment).
    if (current.isOver) return
    // ICE restart from the other side: numbered, so a late or repeated one is ignored; the DTLS fingerprints
    // must be the ones of this call (the key emoji stay valid); glare: the caller's offer wins.
    if (step == "restart" && sdp != null && gen != null && (current.status == "active" || current.status == "connecting")) {
      val made = media ?: return
      val theirs = stripped(sdp)
      val input = mapOf<String, Any?>("gen" to gen, "lastRemoteGen" to lastRemoteGen, "signalingState" to made.signalingState, "polite" to current.incoming,
        "fingerprintsMatch" to CallRules.flag("callSameFingerprints", listOf(theirs, current.remoteSdp ?: "")), "pendingAgeMs" to CallRules.nowMs - pendingAt)
      val decision = CallRules.words("callRemoteRestart", listOf(input)) ?: "ignore-stale"
      if (decision != "answer" && decision != "rollback-and-answer") return
      lastRemoteGen = gen
      val reply = {
        answer(made, theirs, again = true) { own ->
          // Not made: the other side retries with a newer number.
          val now = call
          if (own != null && now != null && now.id == callId && !now.isOver && media === made) {
            send(now, mapOf("type" to "call", "call" to callId, "step" to "restart-answer", "gen" to gen, "sdp" to marked(own)))
          }
        }
      }
      if (decision == "rollback-and-answer") {
        pendingGen = null
        made.setLocal("rollback", "") { reply() }
      } else reply()
      return
    }
    if (step == "restart-answer" && sdp != null && gen != null) {
      val made = media ?: return
      val theirs = stripped(sdp)
      val input = mapOf<String, Any?>("gen" to gen, "pendingGen" to pendingGen, "signalingState" to made.signalingState,
        "fingerprintsMatch" to CallRules.flag("callSameFingerprints", listOf(theirs, current.remoteSdp ?: "")))
      if (!CallRules.flag("callRestartAnswerFits", listOf(input))) return
      pendingGen = null
      made.setRemote("answer", theirs) { }
      return
    }
    if (step == "answer" && sdp != null && (current.status == "active" || current.status == "connecting") && media?.signalingState == "have-local-offer") {
      media?.setRemote("answer", stripped(sdp)) { }
      return
    }
    if (step == "answer" && !current.incoming && sdp != null) {
      cancel(ringTimer)
      cancel(reachTimer)
      CallSounds.stop()
      patch { it.copy(status = "connecting", remoteSdp = sdp) }
      val made = media ?: return
      made.setRemote("answer", stripped(sdp)) { fine ->
        if (!isCurrent(callId) || media !== made) return@setRemote
        if (fine) showKey(made.localSdp, sdp) else finish("Не удалось соединиться", "failed")
      }
      return
    }
    if (step == "end") finish(CallRules.endedWords(action["reason"] as? String), null)
  }

  /** An offer that may ring: the incoming call comes up — or, with a call already on, the caller hears «busy». */
  private fun rings(chatId: String, peer: Person, callId: String, video: Boolean, sdp: String) {
    if (call != null) {
      // Busy: the same `end` as a hang-up, so the caller's chat says «Собеседник занят» and ours a missed call.
      messenger?.sendCallSignal(chatId, peer.id, CallRules.end(callId, video, incoming = true, startedAt = null, reason = "busy"))
      return
    }
    samples = null
    call = CallState(callId, chatId, peer, incoming = true, video = video, status = "incoming", speaker = video, remoteSdp = sdp)
    began()
    app?.let { CallSounds.play(it, "incoming"); CallSounds.vibrate(it) }
    cancel(ringTimer)
    ringTimer = after(CallRules.ringTimeout) {
      if (isCurrent(callId) && call?.status == "incoming") finish("Пропущенный звонок", null)
    }
  }

  /** «Ответить». */
  fun accept() {
    samples?.let { sample -> return patch { sample.answered(it) } }
    val current = call ?: return
    val offer = current.remoteSdp
    if (current.status != "incoming" || offer == null) return
    val id = current.id
    cancel(ringTimer)
    CallSounds.stop()
    CallSounds.still()
    try { MusicPlayer.shared.stop() } catch (_: Exception) {}
    tap()
    patch { it.copy(status = "connecting") }
    CallAudio.allow(window.get(), current.video) asked@{ refusal ->
      if (!isCurrent(id)) return@asked
      if (refusal != null) return@asked finish(refusal, "failed")
      app?.let { CallAudio.start(it, current.video) }
      prepare(id, current.video) prepared@{ made ->
        if (!isCurrent(id)) return@prepared
        if (made == null) return@prepared finish("Не удалось ответить", "failed")
        answer(made, stripped(offer), again = false) answered@{ own ->
          val now = call
          if (now == null || now.id != id || now.isOver) return@answered
          if (own == null) return@answered finish("Не удалось ответить", "failed")
          send(now, mapOf("type" to "call", "call" to id, "step" to "answer", "sdp" to marked(own)))
          showKey(own, offer)
        }
      }
    }
  }

  /** The four emoji of the call's key: both sides see the same once both SDPs are known. */
  private fun showKey(local: String, remote: String) {
    val emoji = (Core.view("callKey", listOf(local, remote)) as? List<*>)?.mapNotNull { it as? String } ?: return
    if (emoji.size == 4) patch { it.copy(key = emoji) }
  }

  // The running call

  private fun connectionMoved(state: String) {
    val current = call ?: return
    if (state == "connected" && current.status != "active" && current.status != "ended") {
      resetLink()
      tap()
      patch { it.copy(status = "active", startedAt = CallRules.nowMs) }
      return
    }
    // Once the call is up, a drop is not the end: «Восстановление связи…», ICE restarts, «Связь потеряна» after 30 s.
    if (current.status == "active") return feedLink(mapOf("kind" to "state", "state" to state))
    if (state == "failed") finish("Не удалось соединиться", "failed")
  }

  private fun resetLink() {
    cancel(linkTimer)
    linkTimer = null
    link = null
    restartGen = 0
    pendingGen = null
    lastRemoteGen = 0
    restarting = false
  }

  /** One input into the reconnect state machine (the connection's state, a change of network, its own timer). */
  private fun feedLink(input: Map<String, Any?>) {
    val current = call ?: return
    if (current.status != "active" || media == null) return
    // The caller acts first; the callee waits a little longer, so usually only one restart offer is in flight.
    val step = CallRules.fields("callLinkNext", listOf(link, input, CallRules.nowMs, current.incoming))
    val next = Core.map(step["link"]) ?: return
    link = next
    cancel(linkTimer)
    linkTimer = null
    (step["wakeAt"] as? Number)?.toDouble()?.let { wakeAt ->
      linkTimer = after(maxOf(0.0, wakeAt - CallRules.nowMs).toLong()) { feedLink(mapOf("kind" to "timer")) }
    }
    val showing = step["showing"] as? Boolean ?: false
    if (current.reconnecting != showing) patch { it.copy(reconnecting = showing) }
    if (step["recovered"] == true) tap()
    if (step["end"] == true) return finish("Связь потеряна", "failed")
    if (step["restart"] == true) sendRestart()
  }

  /** An ICE restart offer, numbered, inside the same encrypted signalling as the first SDP. */
  private fun sendRestart() {
    val current = call ?: return
    val made = media ?: return
    if (current.status != "active" || restarting) return
    // An older app on the other side does not know the `restart` step: ICE may still recover by itself.
    if (!CallRules.flag("callRestartCapable", listOf(current.remoteSdp))) return
    restarting = true
    restartGen += 1
    val gen = restartGen
    pendingGen = gen
    pendingAt = CallRules.nowMs
    offer(made, restart = true) { sdp ->
      // Not made: the next attempt is on the timer.
      restarting = false
      val now = call
      if (sdp != null && now != null && now.id == current.id && !now.isOver && media === made && pendingGen == gen) {
        send(now, mapOf("type" to "call", "call" to now.id, "step" to "restart", "gen" to gen, "sdp" to marked(sdp)))
      }
    }
  }

  /** The link is read from the connection itself every three seconds for the whole call: when packets are lost
   *  or late the voice is made lighter at once and the picture gives way first; when the link has been calm for
   *  a while the quality comes back step by step. */
  private fun readLink() {
    val current = call ?: return
    val made = media ?: return
    if (current.status != "active") return
    made.statistics { reports ->
      val now = call
      if (now == null || now.id != current.id || now.isOver || now.status != "active" || media !== made) return@statistics
      val answer = CallRules.fields("callLink", listOf(reports, linkSample, CallRules.nowMs))
      val reading = Core.map(answer["link"]) ?: return@statistics
      linkSample = Core.map(answer["sample"])
      linkReading = reading
      val step = CallRules.fields("callGrade", listOf(reading, now.grade, calm))
      calm = (step["calm"] as? Number)?.toInt() ?: 0
      val grade = step["grade"] as? String
      if (grade == null || grade == now.grade) return@statistics
      val caps = CallRules.fields("callCaps", listOf(CallRules.tier, grade))
      made.cap("audio", (caps["audio"] as? Number)?.toDouble())
      made.cap("video", (caps["video"] as? Number)?.toDouble())
      patch { it.copy(grade = grade) }
    }
  }

  /** The lines of the diagnostics (a tap on the status): the route, the delay, the losses, the bitrates. */
  val linkLines: List<String>
    get() {
      val empty = mapOf<String, Any?>("route" to null, "rttMs" to null, "lossPct" to null, "jitterMs" to null, "kbpsOut" to null, "kbpsIn" to null)
      return (Core.view("callLinkLines", listOf(linkReading ?: empty, CallRules.tier)) as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    }

  // The controls

  /** «Завершить» / «Отклонить»: the reason by status — a call that never connected is never an answered call. */
  fun hangup() {
    val current = call ?: return
    if (current.isOver) return
    val outcome = CallRules.fields("callHangup", listOf(current.status, current.incoming))
    finish(outcome["text"] as? String ?: "Звонок завершён", outcome["reason"] as? String)
  }

  fun toggleMute() {
    val current = call ?: return
    if (current.isOver) return
    media?.setMicrophone(current.muted)
    patch { it.copy(muted = !current.muted) }
    tap()
  }

  /** «Динамик». */
  fun toggleSpeaker() {
    val current = call ?: return
    if (current.isOver) return
    CallAudio.route(CallRules.speakerRoute(!current.speaker, current.video), current.video)
    patch { it.copy(speaker = !current.speaker) }
    tap()
  }

  /** «Видео»: switches this phone's camera off and on; during an audio call the first press turns the call
   *  into a video call (a new offer inside the same call). */
  fun toggleCamera() {
    val current = call ?: return
    if (current.isOver) return
    if (isDemo) return patch { it.copy(cameraOff = !current.cameraOff) }
    val made = media ?: return
    if (!made.hasCamera) return enableVideo()
    if (!current.video) return
    made.setCamera(current.cameraOff)
    patch { it.copy(cameraOff = !current.cameraOff) }
    tap()
  }

  private fun enableVideo() {
    val current = call ?: return
    val made = media ?: return
    if (current.status != "active") return
    val id = current.id
    CallAudio.allowCamera(window.get()) { refusal ->
      // The camera is not allowed: the call goes on with audio.
      if (refusal != null || !isCurrent(id) || media !== made || call?.status != "active") return@allowCamera
      made.addCamera()
      // The phone has no camera to open: the call stays an audio call.
      if (!made.hasCamera) return@allowCamera
      CallAudio.route(true, video = true)
      patch { it.copy(video = true, cameraOff = false, speaker = true, localVideo = made.hasCamera) }
      offer(made, restart = false) { sdp ->
        val now = call
        if (sdp != null && now != null && now.id == id && !now.isOver && media === made) {
          send(now, mapOf("type" to "call", "call" to id, "step" to "offer", "video" to true, "sdp" to marked(sdp)))
          tap()
        }
      }
    }
  }

  /** «Повернуть»: the other camera. */
  fun flipCamera() {
    media?.flipCamera()
    tap()
    // The small picture is a mirror for the front camera only.
    after(300) { changed.post(Unit) }
  }

  fun minimize() {
    val current = call ?: return
    if (current.status == "incoming" || current.isOver) return
    patch { it.copy(minimized = true) }
  }

  fun restore() { patch { it.copy(minimized = false) } }

  /** «Нет соединения» → «Повторить»: the same chat, the same kind of call, a new call id. */
  fun retry() {
    val current = call ?: return
    if (!current.isOver) return
    samples?.let { return it.again() }
    call = null
    place(current.chatId, current.peer, current.video)
  }

  /** «Закрыть». */
  fun close() {
    if (call?.isOver != true) return
    call = null
  }

  // The end

  /** A call is on from here: the line stays open with it, and the call's own beat runs. */
  private fun began() {
    messenger?.live?.heldByCall = true
    beats = 0
    cancel(beat)
    val made = object : Runnable { override fun run() { tick(); main.postDelayed(this, 250) } }
    beat = made
    main.postDelayed(made, 250)
  }

  private fun tick() {
    beats += 1
    checkGathering()
    // The connection is asked for its state as well as heard, and for its statistics every three seconds.
    if (beats % 4 == 0) media?.tellState()
    if (beats % 12 == 0) readLink()
  }

  private fun cleanup() {
    resetLink()
    cancel(ringTimer); ringTimer = null
    cancel(reachTimer); reachTimer = null
    cancel(beat); beat = null
    ringTone = ""
    for (wait in gatherWaits) wait.cancel()
    gatherWaits.clear()
    // Whoever still waits for the network finds the call gone when its own time runs out.
    networkWaiters.clear()
    CallSounds.stop()
    CallSounds.still()
    media?.close()
    media = null
    CallAudio.stop()
    linkSample = null
    linkReading = null
    calm = 0
    messenger?.live?.heldByCall = false
  }

  /** The call ends with these words on the screen. `notify`: the reason the other side is told (the `end` both
   *  chats show as the call's row); null — nothing is sent. `retry`: «Нет соединения» stays with «Повторить». */
  private fun finish(words: String, notify: String?, retry: Boolean = false) {
    val current = call ?: return
    if (current.isOver) return
    if (notify != null) send(current, CallRules.end(current, notify))
    cleanup()
    call = current.copy(status = "ended", endedText = words, retry = retry, localVideo = false, remoteVideo = false, reconnecting = false,
      minimized = if (retry) false else current.minimized)
    if (retry) return
    after(1600) {
      val ended = call
      if (ended != null && ended.id == current.id && ended.isOver) call = null
    }
  }

  // The signalling road

  /** Calls back with true once the signalling road is up, false after `networkWait` or when this call is gone. */
  private fun waitForNetwork(id: String, done: (Boolean) -> Unit) {
    if (signalNetwork == "online") return done(true)
    var settled = false
    val wake: (Boolean) -> Unit = { online ->
      if (!settled) {
        settled = true
        done(online && isCurrent(id))
      }
    }
    networkWaiters.add(Pair(id, wake))
    after(CallRules.networkWait) {
      if (!settled) {
        networkWaiters.removeAll { it.first == id }
        wake(false)
      }
    }
  }

  /** The live line or the phone's network changed: whoever waits for the road is woken, the screens show it. */
  private fun networkMoved() {
    if (signalNetwork == "online") {
      val waiting = networkWaiters.toList()
      networkWaiters.clear()
      for (waiter in waiting) waiter.second(true)
    }
    if (call != null) changed.post(Unit)
  }

  // The debug build's samples

  /** One state of a call on made-up data — no account, no server, no microphone, no camera (src/debug CallsDemo.kt). */
  fun showSample(sample: CallState, from: Samples) {
    cleanup()
    samples = from
    call = sample
  }
}
