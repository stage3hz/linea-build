package com.linea.messenger.rooms

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.music.MusicTrack
import com.linea.messenger.net.Live
import com.linea.messenger.people.Person
import kotlin.math.abs

/** Music for everyone in a room (the reference's roomMusic.tsx): on a phone only in headphones — from the phone's
 *  own loudspeaker the music would go straight back into the microphone and everyone would hear it twice.
 *  One person turns it on; what they play (which track, where in it, playing or paused) is told to the others
 *  straight over the room's own peer-to-peer channel, and every device plays the track itself from the catalogue.
 *  No sound is sent and the server sees nothing. A phone without headphones takes no part: it neither plays nor
 *  leads. The wire's rules are the shared core's (`roomMusicIn`, `roomMusicOut`). Main thread only. */
object RoomMusic {
  /** Posted on the main thread when what plays for everyone (or who leads it) changed. */
  val changed = Live.Signal<Unit>()

  /** "me" while this phone leads, a connection's id while that person leads, null when nothing is shared. */
  var host: String? = null
    private set
  /** The track the one who leads plays, as they told it. */
  var track: Map<String, Any?>? = null
    private set
  /** Whether music for everyone may run here: inside a room, with the sound in headphones. */
  var allowed = false
    private set
  private var started = false
  private var beat: Runnable? = null
  private var told = ""
  private var app: Context? = null
  private var demoAllowed = false
  private val main = Handler(Looper.getMainLooper())
  private val player: MusicPlayer get() = MusicPlayer.shared

  /** Headphones were connected or taken away. */
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { moved() }
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) { moved() }
  }

  /** Begins to follow the room this phone is in. Called once (by the shell). */
  fun start(context: Context) {
    app = context.applicationContext
    if (started) return
    started = true
    RoomVoice.onPeerText = { peer, text -> heard(peer, text) }
    // Somebody's channel opened: they are told at once what plays.
    RoomVoice.onPeerReady = { if (host == "me") tell() }
    // Leaving the room while leading: the others are told while the connections are still open.
    RoomVoice.onLeaving = { if (host == "me") RoomVoice.sendToPeers(RoomRules.musicOff) }
    RoomVoice.changed.watch { moved() }
    try { (app?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.registerAudioDeviceCallback(devices, main) } catch (_: Exception) {}
    player.changed.watch { playerMoved() }
  }

  /** The room, or where the phone's sound goes, changed. */
  private fun moved() { main.post { check() } }

  private fun check() {
    val now = if (RoomVoice.isDemo) RoomVoice.state != null && demoAllowed else RoomVoice.state != null && RoomVoice.headphones(app)
    // The one who led left the room without a word (their connection dropped): nothing is shared any more.
    val leader = host
    if (leader != null && leader != "me" && now && RoomVoice.userIdOfPeer(leader) == null) {
      host = null
      track = null
      if (player.playing) player.togglePlayback()
      changed.post(Unit)
    }
    if (now == allowed) return
    allowed = now
    if (!now) end()
    changed.post(Unit)
  }

  /** Leaving the room, or taking the headphones off: the lead ends for everyone; what was playing along stops. */
  private fun end() {
    if (host == "me") RoomVoice.sendToPeers(RoomRules.musicOff)
    else if (host != null && player.playing) player.togglePlayback()
    host = null
    track = null
    beat?.let { main.removeCallbacks(it) }
    beat = null
    told = ""
    demoAllowed = false
  }

  // Listening: follow whoever leads

  private fun heard(peer: String, text: String) {
    if (!allowed) return
    val data = Core.map(Core.view("roomMusicIn", listOf(text)) as? Map<*, *>) ?: return
    if (data["off"] == true) {
      if (host != peer) return
      host = null
      track = null
      if (player.playing) player.togglePlayback()
      changed.post(Unit)
      return
    }
    val wanted = Core.map(data["track"] as? Map<*, *>) ?: return
    val id = wanted["id"] as? String ?: return
    val source = wanted["source"] as? String ?: return
    val place = (data["place"] as? Number)?.toDouble() ?: return
    if (host == "me") {
      beat?.let { main.removeCallbacks(it) }
      beat = null
    }
    host = peer
    track = wanted
    if (player.current?.id != id) {
      val made = MusicTrack(id = id, source = source, sourceId = wanted["sourceId"] as? String, title = wanted["title"] as? String ?: "", artist = wanted["artist"] as? String ?: "",
        duration = (wanted["duration"] as? Number)?.toDouble() ?: 0.0)
      // The place is taken at the next word from the one who leads, once the track has loaded here.
      player.play(made)
    } else {
      if (abs(player.position - place) > RoomRules.musicDrift) player.seek(place)
      val playing = data["playing"] as? Boolean ?: false
      if (player.playing != playing && !player.loading) player.togglePlayback()
    }
    changed.post(Unit)
  }

  // Leading: tell the others on every change and on a slow beat

  /** «Включить … для всех». */
  fun lead() {
    val current = player.current ?: return
    if (!allowed || current.source == "local") return
    host = "me"
    track = null
    told = ""
    tell()
    beat?.let { main.removeCallbacks(it) }
    val ticks = object : Runnable { override fun run() { tell(); main.postDelayed(this, RoomRules.musicBeat) } }
    beat = ticks
    main.postDelayed(ticks, RoomRules.musicBeat)
    changed.post(Unit)
  }

  /** «Выключить». */
  fun stopLeading() {
    if (host != "me") return
    RoomVoice.sendToPeers(RoomRules.musicOff)
    host = null
    beat?.let { main.removeCallbacks(it) }
    beat = null
    changed.post(Unit)
  }

  private fun tell() {
    val current = player.current ?: return
    if (host != "me") return
    // A file of the phone's own gives no text: it cannot be played for everyone.
    val text = Core.view("roomMusicOut", listOf(current.json, player.position, player.playing)) as? String ?: return
    told = current.id + if (player.playing) "|1" else "|0"
    RoomVoice.sendToPeers(text)
  }

  private fun playerMoved() {
    if (host != "me") {
      if (host != null || allowed) changed.post(Unit)
      return
    }
    val key = (player.current?.id ?: "") + if (player.playing) "|1" else "|0"
    if (key != told) tell()
    changed.post(Unit)
  }

  /** What plays for everyone, without a room's connections (`--es roomsdemo music`). */
  fun showDemo(host: String, track: Map<String, Any?>) {
    demoAllowed = true
    allowed = true
    this.host = host
    this.track = track
    changed.post(Unit)
  }
}

/** The line under the people of a room: what plays for everyone, or the button that starts it; on a phone without
 *  headphones — why there is no music here. */
class RoomMusicLine(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val icon = RoomIconView(context, "music.note", 18f, Theme.text)
  private val heading = context.words("", 15.5f, Theme.text, 600)
  private val words: TextView = context.words("", 12.5f, Theme.muted)
  private val off = context.words("Выключить", 13f, Theme.text)
  private var playingFor = false
  private var canLead = false
  /** How tall the line is now, dp. */
  var tall = 0f
    private set

  init {
    for (label in listOf(heading, words)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END }
    off.gravity = Gravity.CENTER
    off.background = context.plate(0, 17f, Theme.veil(0.18f))
    off.contentDescription = "Выключить музыку для всех"
    off.isClickable = true
    off.setOnClickListener { RoomMusic.stopLeading() }
    for (part in listOf(icon, heading, words, off)) addView(part)
    setOnClickListener { if (canLead && !playingFor) RoomMusic.lead() }
  }

  /** `inside`: whether this phone is inside the room on screen; `members`: for the name of the one who leads. */
  fun show(inside: Boolean, members: List<Person>) {
    val music = RoomMusic
    val player = MusicPlayer.shared
    playingFor = false
    canLead = false
    off.visibility = GONE
    heading.visibility = GONE
    icon.visibility = GONE
    isClickable = false
    alpha = 1f
    if (!inside) {
      tall = 0f
      visibility = GONE
      return
    }
    visibility = VISIBLE
    if (!music.allowed) {
      words.text = "Музыка для всех — на телефоне только в наушниках"
      words.textSize = 12.5f
      words.setTextColor(Theme.subtle)
      words.gravity = Gravity.CENTER
      tall = 18f
      contentDescription = null
      return requestLayout()
    }
    val leading = music.host == "me"
    val shownName = if (leading) player.current?.title else if (music.host != null) music.track?.get("title") as? String else null
    val host = music.host
    if (host != null && shownName != null) {
      playingFor = true
      val by = if (leading) "ты" else RoomVoice.userIdOfPeer(host).let { userId -> members.firstOrNull { it.id == userId }?.let { RoomRules.firstName(it) } ?: "кто-то" }
      icon.visibility = VISIBLE
      icon.color = Theme.text
      icon.background = context.plate(Theme.veil(0.08f), 13f)
      heading.visibility = VISIBLE
      heading.text = shownName
      words.text = "включил $by · играет у всех"
      words.textSize = 12.5f
      words.setTextColor(Theme.muted)
      words.gravity = Gravity.START or Gravity.CENTER_VERTICAL
      off.visibility = if (leading) VISIBLE else GONE
      tall = 44f
      return requestLayout()
    }
    val current = player.current
    val local = current?.source == "local"
    canLead = current != null && !local
    icon.visibility = VISIBLE
    icon.color = Theme.muted
    icon.background = null
    words.text = when {
      local -> "Свой файл нельзя включить для всех — выбери трек из каталога"
      current != null -> "Включить «${current.title.take(40)}» для всех"
      else -> "Музыка для всех: включи трек в «Музыке»"
    }
    words.textSize = 13.5f
    words.setTextColor(Theme.muted)
    words.gravity = Gravity.START or Gravity.CENTER_VERTICAL
    isClickable = canLead
    contentDescription = words.text
    alpha = if (canLead) 1f else 0.55f
    tall = 22f
    requestLayout()
  }

  override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(tall))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val height = b - t
    if (playingFor) {
      put(icon, 0, 0, dp(44f), dp(44f))
      var right = width
      if (off.visibility == VISIBLE) {
        off.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val wide = off.measuredWidth + dp(24f)
        put(off, width - wide, dp(5f), wide, dp(34f))
        right -= wide + dp(12f)
      }
      put(heading, dp(56f), dp(3f), right - dp(56f), dp(20f))
      put(words, dp(56f), dp(24f), right - dp(56f), dp(17f))
    } else if (icon.visibility != VISIBLE) {
      put(words, 0, 0, width, height)
    } else {
      words.measure(MeasureSpec.makeMeasureSpec(width - dp(26f), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
      val wide = minOf(width - dp(26f), words.measuredWidth)
      val left = (width - wide - dp(26f)) / 2
      put(icon, left, 0, dp(20f), height)
      put(words, left + dp(26f), 0, wide, height)
    }
  }
}
