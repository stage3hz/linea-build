package com.linea.messenger.rooms

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import com.linea.messenger.app.Messenger
import com.linea.messenger.calls.CallSounds
import com.linea.messenger.calls.Calls
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.people.Person
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen
import java.lang.ref.WeakReference

/** The rooms of the signed-in account: the list (read once, then kept current by the live line's events) and the
 *  «зовёт в комнату» call that is ringing right now. The reference's rooms.ts and the `RoomsHost` of
 *  RoomsSection.tsx. What an event does to the list is the shared core's (`roomEvent`); the voice is RoomVoice.
 *  Main thread only. */
object Rooms {
  /** Posted on the main thread when the list, a room in it or the ring changed. */
  val changed = Live.Signal<Unit>()

  /** null until the list has been read once. */
  var rooms: List<Room>? = null
    private set
  var ring: RoomRing? = null
    private set
  /** Why the list could not be read; empty when it could. */
  var failure = ""
    private set

  /** The list and the ring as the server words them: what the core's rules read and write. */
  private var rawRooms: List<Map<String, Any?>>? = null
  private var rawRing: Map<String, Any?>? = null
  private var messenger: Messenger? = null
  private var observing = false
  private var ringTimer: Runnable? = null
  private var ringSounds = false
  private var ringAt = 0.0
  private var app: Context? = null
  private var window = WeakReference<Activity>(null)
  private var demoMe: Person? = null
  private val main = Handler(Looper.getMainLooper())

  private val heard: (Map<String, Any?>) -> Unit = { event(it) }
  private val voiceWatch: (Unit) -> Unit = { voiceMoved() }

  // The account

  /** Begins to follow the account (a new sign-in forgets what the previous account had). null: the debug build's
   *  shell without an account. */
  fun start(context: Context, messenger: Messenger?) {
    (context as? Activity)?.let { window = WeakReference(it) }
    app = context.applicationContext
    RoomVoice.attach(context as? Activity)
    if (!observing) {
      observing = true
      Live.roomEvent.watch(heard)
      RoomVoice.changed.watch(voiceWatch)
    }
    if (messenger != null && this.messenger === messenger) return
    // The samples stay when the shell is built again (a theme put on) without an account.
    if (messenger == null && demoMe != null) return
    demoMe = null
    if (this.messenger != null) RoomVoice.stop()
    this.messenger = messenger
    failure = ""
    show(null, null)
    if (messenger != null) load()
  }

  /** The account was left: nothing of it may be shown to the next one, and the room it was in is left. */
  fun stop() {
    RoomVoice.stop()
    messenger = null
    demoMe = null
    failure = ""
    show(null, null)
  }

  /** An account's work on this device ends (`Messenger.close`): its rooms end with it. */
  fun left(account: Messenger) { if (messenger === account) stop() }

  val account: Messenger? get() = messenger

  /** This account's id. */
  val userId: String get() = demoMe?.id ?: messenger?.userId ?: ""

  /** This account as a person (its own picture in the middle of a room). */
  val me: Person? get() = demoMe ?: Person.from(messenger?.user)

  /** Where a person's picture is asked for (empty: they have none). */
  fun pictureAddress(person: Person): String = messenger?.personAvatarAddress(person.avatarId) ?: ""

  /** True while somebody is inside any of the rooms (the quiet dot on «Каналы»). */
  val awake: Boolean get() = rooms?.any { it.inside.isNotEmpty() } ?: false

  fun room(id: String): Room? = rooms?.firstOrNull { it.id == id }

  // The list

  fun load() {
    val messenger = messenger ?: return
    messenger.server.op("rooms", emptyList()) { result ->
      main.post {
        if (this.messenger !== messenger) return@post
        if (result.isSuccess) {
          val list = (Core.map(result.getOrNull())?.get("rooms") as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }
          failure = ""
          val sorted = (Core.view("roomSort", listOf(list)) as? List<*>)?.mapNotNull { Core.map(it as? Map<*, *>) } ?: list
          show(sorted, rawRing)
        } else {
          failure = Server.error(result).words.ifEmpty { "Не удалось загрузить комнаты." }
          changed.post(Unit)
        }
      }
    }
  }

  private fun event(data: Map<String, Any?>) {
    if (messenger == null) return
    val type = data["type"] as? String ?: return
    // The line is up again: whatever happened meanwhile is read afresh.
    if (type == "ready") return load()
    if (!type.startsWith("room.")) return
    apply(data)
  }

  /** One event about rooms, by the core's rules. */
  private fun apply(data: Map<String, Any?>) {
    val held = mapOf("openId" to null, "rooms" to rawRooms, "ring" to rawRing)
    val next = Core.map(Core.view("roomEvent", listOf(held, data, userId, RoomRules.nowMs)) as? Map<*, *>) ?: return
    show((next["rooms"] as? List<*>)?.mapNotNull { Core.map(it as? Map<*, *>) }, Core.map(next["ring"] as? Map<*, *>))
  }

  private fun show(rooms: List<Map<String, Any?>>?, ring: Map<String, Any?>?) {
    rawRooms = rooms
    rawRing = ring
    this.rooms = rooms?.mapNotNull { Room.from(it) }
    val rang = RoomRing.from(ring)
    this.ring = rang
    ringMoved(rang)
    changed.post(Unit)
  }

  /** Drops a room from the list at once (this account left it); the server's own event confirms it later. */
  fun forget(id: String) {
    val list = rawRooms ?: return
    show(list.filter { it["id"] as? String != id }, if (rawRing?.get("roomId") as? String == id) null else rawRing)
  }

  /** The room this phone is inside changed: the rows of the list say «ты внутри». */
  private fun voiceMoved() {
    // Walking in answers the ring.
    val ring = ring
    if (ring != null && RoomVoice.state?.roomId == ring.roomId) return dismissRing()
    changed.post(Unit)
  }

  // The ring

  /** A ring began, or ended: the melody and the half-minute it lasts. An ordinary call that is ringing or going
   *  on, and a room this phone is inside, keep the phone's sound: the room's call is then shown silently. */
  private fun ringMoved(ring: RoomRing?) {
    val at = ring?.at ?: 0.0
    if (at == ringAt) return
    ringAt = at
    ringTimer?.let { main.removeCallbacks(it) }
    ringTimer = null
    if (ringSounds) {
      ringSounds = false
      if (Calls.call == null) CallSounds.stop()
    }
    if (ring == null) return
    try { window.get()?.window?.decorView?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) } catch (_: Exception) {}
    val quiet = Calls.call != null || RoomVoice.state != null || demoMe != null
    if (!quiet) {
      ringSounds = true
      app?.let { CallSounds.play(it, "incoming") }
    }
    val timer = Runnable { dismissRing() }
    ringTimer = timer
    main.postDelayed(timer, RoomRules.ringTime)
  }

  /** «Не сейчас», or the ring's time ran out. */
  fun dismissRing() {
    if (rawRing == null) return
    show(rawRooms, null)
  }

  /** «Зайти» on the ring: the room opens and this phone walks in. */
  fun answerRing() {
    val ring = ring ?: return
    val known = room(ring.roomId)
    dismissRing()
    RoomRouter.open(ring.roomId)
    // A failure is shown by the room's own screen, next to «Зайти».
    if (known != null) enter(known) { }
  }

  // What the person does

  /** Walks into the room: the microphone opens and the others hear this phone. */
  fun enter(room: Room, done: (String?) -> Unit) {
    if (demoMe != null) return done(null)
    val messenger = messenger ?: return done("Нет соединения с сервером.")
    if (ring?.roomId == room.id) dismissRing()
    RoomVoice.join(messenger, room.id, room.name, done)
  }

  fun exit() = RoomVoice.leave()

  private fun call(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>, String) -> Unit) {
    val messenger = messenger ?: return
    messenger.server.op(name, args) { result ->
      main.post { done(if (result.isSuccess) Result.success(Core.map(result.getOrNull()) ?: emptyMap()) else Result.failure(Server.error(result)), if (result.isSuccess) "" else Server.error(result).words) }
    }
  }

  /** «Позвать всех»: everyone who is not inside gets the ring. `done`: how many were called, or the words that say why not. */
  fun ringAll(id: String, done: (Int, String?) -> Unit) {
    if (messenger == null) return done(0, null)
    call("ringRoom", listOf(id)) { result, words ->
      if (result.isSuccess) done((result.getOrNull()?.get("rang") as? Number)?.toInt() ?: 0, null)
      else done(0, words.ifEmpty { "Не удалось позвать." })
    }
  }

  /** A new name; an empty one brings back the name made of the members' names. */
  fun rename(id: String, name: String, done: (String?) -> Unit) {
    if (messenger == null) return done(null)
    call("renameRoom", listOf(id, name.trim())) { result, words ->
      if (result.isSuccess) {
        // The server tells every member (`room.updated`); this phone need not wait for it.
        Core.map(result.getOrNull()?.get("room") as? Map<*, *>)?.let { apply(mapOf("type" to "room.updated", "room" to it)) }
        done(null)
      } else done(words.ifEmpty { "Не удалось переименовать." })
    }
  }

  /** «Уйти из комнаты насовсем»: out of its voice, then out of its members. */
  fun leaveForGood(id: String, done: (String?) -> Unit) {
    if (messenger == null) return done(null)
    if (RoomVoice.state?.roomId == id) exit()
    call("leaveRoom", listOf(id)) { result, words ->
      if (result.isSuccess) { forget(id); done(null) } else done(words.ifEmpty { "Не удалось выйти." })
    }
  }

  /** A group call from the chat list: the room of exactly these people is found or made, opened on screen,
   *  entered, and everyone else is called. One person is an ordinary call and never reaches this.
   *  `done` gets null, or the words that say why not. */
  fun startCall(memberIds: List<String>, done: (String?) -> Unit) {
    if (messenger == null) return done("Нет соединения с сервером.")
    val check = Core.map(Core.view("roomCallCheck", listOf(memberIds, userId)) as? Map<*, *>) ?: emptyMap()
    (check["error"] as? String)?.let { return done(it) }
    val ids = (check["ids"] as? List<*>)?.mapNotNull { it as? String } ?: return done("Не удалось позвонить.")
    call("createRoom", listOf(ids)) { result, words ->
      if (result.isFailure) return@call done(words.ifEmpty { "Не удалось позвонить." })
      val raw = Core.map(result.getOrNull()?.get("room") as? Map<*, *>)
      val room = Room.from(raw)
      if (raw == null || room == null) return@call done("Не удалось позвонить.")
      apply(mapOf("type" to "room.updated", "room" to raw))
      RoomRouter.open(room.id)
      enter(room) { words ->
        if (words != null) return@enter done(words)
        // Not called: the others still see the room awake and can walk in.
        ringAll(room.id) { _, _ -> }
        done(null)
      }
    }
  }

  // The debug build's samples

  /** The list and the ring without an account or a server (`--es roomsdemo`). */
  fun showDemo(me: Person, rooms: List<Map<String, Any?>>, ring: Map<String, Any?>?) {
    demoMe = me
    failure = ""
    show(rooms, ring)
  }

  val isDemo: Boolean get() = demoMe != null
}

/** Opens a room's screen from anywhere in the app: «Каналы» is where rooms live, so that section comes forward and
 *  the room is pushed over it (Back goes back to the list). */
object RoomRouter {
  private var window = WeakReference<Activity>(null)

  /** The window the app's pages are in (the shell tells it). */
  fun attach(activity: Activity?) { if (activity != null) window = WeakReference(activity) }

  /** The stack of pages of the window. */
  fun navigation(): Navigation? {
    val activity = window.get() ?: return null
    if (activity.isFinishing || activity.isDestroyed) return null
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
    for (index in 0 until content.childCount) (content.getChildAt(index) as? Navigation)?.let { return it }
    return null
  }

  fun open(roomId: String) {
    val stack = navigation() ?: return
    val shown = stack.top
    if (shown is RoomScreen && shown.roomId == roomId) return
    // The root of the stack is the shell; whatever lies over it (a chat, another room) goes.
    var root: RootScreen? = null
    for (index in 0 until stack.childCount) (stack.getChildAt(index) as? RootScreen)?.let { if (root == null) root = it }
    val shell = root ?: return
    RoomPicker.dismissShown()
    val alone = stack.depth == 1
    while (stack.depth > 1) stack.pop(animated = false)
    shell.show("channels")
    stack.push(RoomScreen(shell.context, roomId), animated = alone)
  }
}
