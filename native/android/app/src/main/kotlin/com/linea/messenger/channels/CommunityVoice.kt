package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.rooms.RoomIcons
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.rooms.RoomVoice
import com.linea.messenger.rooms.RoomVoiceState
import com.linea.messenger.settings.ThemeStore

// The voice channels of a game server (mobile/src/communities/CommunityScreen.tsx, MemberMenu.tsx, voice.ts; iOS
// Channels/CommunityVoice.swift): under a voice channel — who is in it, with the microphone and sound marks; a touch on a
// person opens the moderator's actions («Отключить микрофон», «Отключить звук», «Исключить», «Заблокировать» — each only
// with the right); while this phone is in one of the community's channels, a panel with «Микрофон», «Звук», «Динамик»,
// «Выйти». The voice itself is the rooms' engine (rooms/RoomVoice.kt), as in the reference: a full mesh of checked
// WebRTC connections, up to 12.

/** One person in a voice channel, as the server says (`VoiceMember` of the reference's types.ts). */
data class CommunityVoiceMember(val userId: String, val muted: Boolean, val serverMuted: Boolean, val serverDeafened: Boolean) {
  companion object {
    fun from(raw: Any?): CommunityVoiceMember? {
      val fields = raw as? Map<*, *> ?: return null
      val userId = fields["userId"] as? String ?: return null
      if (userId.isEmpty()) return null
      return CommunityVoiceMember(userId, fields["muted"] as? Boolean ?: false, fields["serverMuted"] as? Boolean ?: false, fields["serverDeafened"] as? Boolean ?: false)
    }

    fun list(raw: Any?): List<CommunityVoiceMember> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

object CommunityVoice {
  const val GREEN = 0xFF2FD27A.toInt()
  private val slash = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.STROKE; strokeCap = android.graphics.Paint.Cap.ROUND }

  /** The pictures of the voice channels, drawn by the rooms' own icons: mic, mic.off, speaker, speaker.off, headphones, ear, hangup. */
  /** The reference's glyphs (CommunityScreen.tsx `VoiceButton`, the members' marks), `size` px square. */
  fun icon(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    val glyph = when (name) {
      "mic" -> "mic"; "mic.off" -> "mic-off"; "ear" -> "ear"; "hangup" -> "call"; "speaker.off" -> "volume-mute"; "headphones" -> "headset"
      else -> "volume-high"
    }
    com.linea.messenger.design.IonIcon.draw(canvas, glyph, cx, cy, size, color)
  }

  /** Whether a touch on this person shows any action (`hasMemberActions`). */
  fun hasActions(community: Community, me: String, userId: String): Boolean {
    if (userId == community.summary.ownerId) return false
    return community.can(Perm.muteMembers) || community.can(Perm.deafenMembers) || (userId != me && (community.can(Perm.kick) || community.can(Perm.ban)))
  }

  /** The moderator's actions on a person (`MemberMenuItems`), in their order and words. The server checks the rights and
   *  the role order again. */
  fun items(community: Community, me: String, member: CommunityVoiceMember): List<Pair<String, Pair<String, List<Any?>>>> {
    val out = ArrayList<Pair<String, Pair<String, List<Any?>>>>()
    val isSelf = member.userId == me; val owner = member.userId == community.summary.ownerId
    if (!owner && community.can(Perm.muteMembers)) out.add((if (member.serverMuted) "Включить микрофон" else "Отключить микрофон") to ("setMemberVoice" to listOf(community.id, member.userId, mapOf("muted" to !member.serverMuted))))
    if (!owner && community.can(Perm.deafenMembers)) out.add((if (member.serverDeafened) "Включить звук" else "Отключить звук") to ("setMemberVoice" to listOf(community.id, member.userId, mapOf("deafened" to !member.serverDeafened))))
    if (!isSelf && !owner && community.can(Perm.kick)) out.add("Исключить" to ("kickMember" to listOf(community.id, member.userId)))
    if (!isSelf && !owner && community.can(Perm.ban)) out.add("Заблокировать" to ("banMember" to listOf(community.id, member.userId, null)))
    return out
  }

  fun actions(context: Context, community: Community, me: String, member: CommunityVoiceMember, name: String, messenger: Messenger?, failed: (String) -> Unit) {
    val list = items(community, me, member)
    if (list.isEmpty()) return
    // The app's own sheet with the person's name over the actions, in their order and words (iOS: the action sheet of
    // Channels/CommunityVoice.swift; the reference's MemberMenu.tsx gives the glyphs), «Исключить» and «Заблокировать»
    // in red.
    val choices = list.map { (label, call) ->
      val (operation, args) = call
      val icon = when (label) {
        "Включить микрофон" -> "ion:mic-outline"; "Отключить микрофон" -> "ion:mic-off-outline"
        "Включить звук" -> "ion:headset-outline"; "Отключить звук" -> "ion:volume-mute-outline"
        "Исключить" -> "ion:person-remove-outline"; else -> "ion:ban-outline"
      }
      com.linea.messenger.chatactions.ChoiceSheet.Choice(icon, label, danger = operation == "kickMember" || operation == "banMember") {
        messenger?.server?.ask(operation, args) { result -> if (result.isFailure) failed(com.linea.messenger.net.Server.error(result).words.ifEmpty { "Не получилось." }) }
      }
    }
    com.linea.messenger.chatactions.ChoiceSheet(context, name, choices = choices).show()
  }
}

/** A person inside a voice channel: a small round picture, the name (« (ты)» for oneself), the moderator's marks in red,
 *  one's own muted microphone in grey. Indented under the channel's name. */
class VoiceMemberCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val avatar = PersonAvatarView(context)
  private val name = context.words("", 14f, Theme.muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
  private var deaf = false
  private var mic = false
  private var micServer = false

  init { addView(avatar); addView(name); setWillNotDraw(false) }

  fun show(member: CommunityVoiceMember, person: Person?, me: String, address: String, actions: Boolean) {
    val known = person ?: Person(member.userId, "", "Участник", "", "", 0x3A4256, "")
    avatar.show(known, address)
    val words = person?.displayName?.takeIf { it.isNotEmpty() } ?: "Участник"
    val shown = words + if (member.userId == me) " (ты)" else ""
    name.text = shown
    deaf = member.serverDeafened
    mic = member.serverMuted || member.muted
    micServer = member.serverMuted
    val marks = ArrayList<String>()
    if (member.serverDeafened) marks.add("звук отключён модератором")
    if (member.serverMuted) marks.add("микрофон отключён модератором") else if (member.muted) marks.add("микрофон выключен")
    contentDescription = (if (actions) "Действия: $words" else shown) + if (marks.isEmpty()) "" else ", " + marks.joinToString(", ")
    requestLayout(); invalidate()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), (36 * d).toInt())

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l; val h = b - t
    val side = (24 * d).toInt()
    avatar.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
    avatar.layout((60 * d).toInt(), (h - side) / 2, (60 * d).toInt() + side, (h + side) / 2)
    var right = w - (20 * d).toInt()
    if (mic) right -= (20 * d).toInt()
    if (deaf) right -= (20 * d).toInt()
    val left = (92 * d).toInt()
    name.measure(MeasureSpec.makeMeasureSpec(maxOf(0, right - left - (4 * d).toInt()), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    name.layout(left, (h - name.measuredHeight) / 2, left + name.measuredWidth, (h + name.measuredHeight) / 2)
  }

  override fun onDraw(canvas: Canvas) {
    var x = width - 20 * d - 8 * d
    val cy = height / 2f
    if (mic) { CommunityVoice.icon(canvas, "mic.off", x, cy, 14 * d, if (micServer) Theme.danger else Theme.subtle); x -= 20 * d }
    if (deaf) CommunityVoice.icon(canvas, "speaker.off", x, cy, 14 * d, Theme.danger)
  }
}

/** The panel while this phone is in one of the community's voice channels: the heading, «Пока никого — позови друзей.»,
 *  the screen sharing (ScreenShare: screenshare/ScreenShareViews.kt), a problem, and the four buttons. On glass. */
@SuppressLint("ViewConstructor")
class CommunityVoicePanel(context: Context) : LinearLayout(context) {
  private val glass = Glass(this)
  private val heading = context.words("", 14f, CommunityVoice.GREEN, 700)
  private val alone = context.words("Пока никого — позови друзей.", 13f, Theme.muted)
  private val problem = context.words("", 13f, Theme.danger)
  private val row = LinearLayout(context)
  private val micButton = CommunityVoiceButton(context)
  private val soundButton = CommunityVoiceButton(context)
  private val speakerButton = CommunityVoiceButton(context)
  private val leaveButton = CommunityVoiceButton(context)
  /** ScreenShare: «Демонстрация экрана», as the reference's ScreenSharePanel under the heading. */
  val screenPanel = com.linea.messenger.screenshare.ScreenSharePanel(context)

  init {
    orientation = VERTICAL
    setWillNotDraw(false)
    setPadding(context.px(14f), context.px(14f), context.px(14f), context.px(14f))
    row.orientation = HORIZONTAL
    for ((index, button) in listOf(micButton, soundButton, speakerButton, leaveButton).withIndex()) row.addView(button, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { if (index > 0) leftMargin = context.px(10f) })
    micButton.setOnClickListener { RoomVoice.toggleMute() }
    soundButton.setOnClickListener { RoomVoice.toggleDeafen() }
    speakerButton.setOnClickListener { RoomVoice.toggleSpeaker() }
    leaveButton.setOnClickListener { RoomVoice.leave() }
    problem.setOnClickListener { RoomVoice.clearError() }
    for ((index, part) in listOf<View>(heading, screenPanel, alone, problem, row).withIndex()) addView(part, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) topMargin = context.px(12f) })
  }

  override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 20 * resources.displayMetrics.density)

  fun show(voice: RoomVoiceState) {
    val connected = voice.status == "connected"
    heading.text = if (connected) "Ты в канале «${voice.name}»" else "Подключение…"
    alone.visibility = if (connected && voice.peers.isEmpty()) VISIBLE else GONE
    screenPanel.show(voice) // ScreenShare
    problem.text = voice.error
    problem.visibility = if (voice.error.isEmpty()) GONE else VISIBLE
    micButton.show(if (voice.muted) "mic.off" else "mic", if (voice.muted) "Микрофон выкл." else "Микрофон", active = !voice.muted, danger = false)
    soundButton.show(if (voice.deafened) "speaker.off" else "headphones", if (voice.deafened) "Звук выкл." else "Звук", active = !voice.deafened, danger = false)
    speakerButton.show(if (voice.speaker) "speaker" else "ear", if (voice.speaker) "Динамик" else "Телефон", active = voice.speaker, danger = false)
    leaveButton.show("hangup", "Выйти", active = false, danger = true)
  }
}

/** One of the panel's buttons: an icon over a short word, the accent's tint while on, red for «Выйти». */
class CommunityVoiceButton(context: Context) : LinearLayout(context) {
  private var symbol = ""
  private var tint = Theme.text
  private val icon = object : View(context) {
    override fun onDraw(canvas: Canvas) = CommunityVoice.icon(canvas, symbol, width / 2f, height / 2f, 20 * resources.displayMetrics.density, tint)
  }
  private val words = context.words("", 12f, Theme.text, 600).apply { gravity = Gravity.CENTER; maxLines = 1 }

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(context.px(4f), context.px(10f), context.px(4f), context.px(10f))
    addView(icon, LayoutParams(LayoutParams.MATCH_PARENT, context.px(22f)))
    addView(words, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    isClickable = true
    isFocusable = true
  }

  fun show(symbol: String, text: String, active: Boolean, danger: Boolean) {
    this.symbol = symbol
    tint = if (danger) 0xFFFFFFFF.toInt() else if (active) Theme.accent else Theme.text
    icon.invalidate()
    words.text = text
    words.setTextColor(if (danger) 0xFFFFFFFF.toInt() else Theme.text)
    background = context.plate(if (danger) Theme.danger else if (active) ThemeStore.look.accentSoft else Theme.surface2, 14f)
    contentDescription = text
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun setPressed(pressed: Boolean) { super.setPressed(pressed); alpha = if (pressed) 0.7f else 1f }
}
