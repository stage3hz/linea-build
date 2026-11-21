package com.linea.messenger.avatars

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.settings.BirthdayWords
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Avatars: a person's decorations and the views that draw them — for the chat list, profiles, mini profiles and
// member lists (iOS: Sources/Avatars). Ported from the reference's platina/Decor.tsx, CodeFrames.tsx,
// Decorations.tsx, Nameplates.tsx, PlatinaMark.tsx, StatusEmoji.tsx, statusEmojiModel.ts and birthday.ts.
//
// HOW TO USE (for every screen):
//
//   val look = PersonLook.from(rawUser)        // from the server's `user` object; `Person.look` too
//   val avatar = DecoratedAvatarView(context)  // avatars/DecoratedAvatarView.kt; its size is the avatar's own,
//   avatar.show(person, look, base, animated)  //   frames and art reach OUTSIDE it (keep clipChildren = false)
//        animated: false in lists (still frame, still photo, no video), true in profiles.
//   PlatinaNameView / PlatinaSealView / PlatinaGemView / StatusEmojiView / NameplateView (avatars/PlatinaMark.kt,
//   StatusEmoji.kt, Nameplates.kt); ChatListDecor.fields(peer) — the chat list's row keys (avatars/ChatListDecor.kt).
//
// Owner's rules over the reference: avatars are round everywhere; frames and art are shown in the chat list and in
// profiles; the chat header shows the plain photo / video avatar and the emoji status only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A person's decorations, as the server sends them in a `user` (the reference's types.ts `User`). */
data class PersonLook(
  /** "platina" while the owner's Platina is active. */
  val seal: String = "",
  val avatarFrame: String = "",
  val avatarVideoId: String = "",
  val bannerId: String = "",
  /** "image" or "video". */
  val bannerKind: String = "",
  val bannerPreset: String = "",
  val profileEffect: String = "",
  val nameplate: String = "",
  val profilePattern: String = "",
  val statusEmoji: String = "",
  val statusExpiry: StatusField = StatusField.Missing,
  val statusPermanent: StatusField = StatusField.Missing,
  /** "male", "female" or empty. */
  val gender: String = "",
  /** «MM-DD» or «YYYY-MM-DD»; empty when not set. */
  val birthday: String = "",
) {
  /** A field that may be missing, explicitly null, or a value (the status rules tell them apart). */
  sealed class StatusField {
    object Missing : StatusField()
    object Null : StatusField()
    data class Text(val value: String) : StatusField()
    data class Flag(val value: Boolean) : StatusField()
    object Other : StatusField()
  }

  val platina: Boolean get() = seal == "platina"
  val hasBanner: Boolean get() = bannerId.isNotEmpty() || (bannerPreset.isNotEmpty() && AvatarCatalog.banners.any { it.id == bannerPreset })
  fun birthdayToday(today: LocalDate = LocalDate.now()): Boolean = AvatarCatalog.isBirthdayToday(birthday, today)

  /** The status emoji to show now, or null (statusEmojiModel.ts `visibleStatusEmoji`, rule for rule): only one of
   *  the fixed set; a permanent one needs the explicit marker and an explicit null expiry; otherwise the expiry
   *  must be a time still ahead. Inconsistent data hides it. */
  fun visibleStatus(now: Instant = Instant.now()): String? {
    if (statusEmoji !in AvatarCatalog.statusEmoji) return null
    if (statusPermanent == StatusField.Flag(true)) return if (statusExpiry == StatusField.Null) statusEmoji else null
    if (statusPermanent != StatusField.Missing && statusPermanent != StatusField.Flag(false)) return null
    val stamp = (statusExpiry as? StatusField.Text)?.value ?: return null
    val at = Messenger.date(stamp) ?: return null
    return if (at.isAfter(now)) statusEmoji else null
  }

  /** When the shown status runs out (null: never, or nothing shown). */
  fun statusEnds(now: Instant = Instant.now()): Instant? {
    if (visibleStatus(now) == null || statusPermanent == StatusField.Flag(true)) return null
    return Messenger.date((statusExpiry as? StatusField.Text)?.value)
  }

  /** The same person in full Platina dress (the showcase's «вот так будешь выглядеть ты»). */
  fun dressed(): PersonLook = copy(seal = "platina", avatarFrame = avatarFrame.ifEmpty { "platinum" }, profileEffect = profileEffect.ifEmpty { "sparks" })

  /** As the chat header shows the person (the owner's rule): no frame, no Platina ring, no birthday ring. */
  fun plain(): PersonLook = copy(avatarFrame = "", seal = "", birthday = "")

  companion object {
    fun from(raw: Any?): PersonLook {
      val fields = Core.map(raw as? Map<*, *>) ?: return PersonLook()
      fun text(key: String) = fields[key] as? String ?: ""
      fun field(key: String): StatusField {
        if (!fields.containsKey(key)) return StatusField.Missing
        return when (val value = fields[key]) {
          null -> StatusField.Null
          is String -> StatusField.Text(value)
          is Boolean -> StatusField.Flag(value)
          else -> StatusField.Other
        }
      }
      return PersonLook(
        seal = text("seal"), avatarFrame = text("avatarFrame"), avatarVideoId = text("avatarVideoId"), bannerId = text("bannerId"),
        bannerKind = text("bannerKind"), bannerPreset = text("bannerPreset"), profileEffect = text("profileEffect"), nameplate = text("nameplate"),
        profilePattern = text("profilePattern"), statusEmoji = text("statusEmoji"), statusExpiry = field("statusEmojiExpiresAt"),
        statusPermanent = field("statusEmojiPermanent"), gender = text("gender"), birthday = text("birthday"),
      )
    }
  }
}

/** A colour of the reference's catalogues: «#RRGGBB» → opaque ARGB (with `alpha` 0…1). */
fun lookColor(hex: String, alpha: Float = 1f): Int = ((Math.round(alpha.coerceIn(0f, 1f) * 255)) shl 24) or Messenger.color(hex)

/** The fixed lists of the reference (and of the server's cosmetics.js): frames, art, banners, plates, effects. */
object AvatarCatalog {
  class Frame(val id: String, val label: String, val colors: List<String>)
  class Item(val id: String, val label: String)
  class Decoration(val id: String, val label: String, val collection: String, val file: String, val scale: Float, val sweep: Boolean, val glow: String, val particles: String, val rise: Boolean)
  class Plate(val id: String, val label: String, val colors: Pair<String, String>)

  /** Platina avatar frames: a gradient ring that slowly turns around the avatar (Decor.tsx FRAMES). */
  val frames = listOf(
    Frame("platinum", "Платина", listOf("#FFFFFF", "#8D97AA", "#F1F4F9", "#6C7588", "#FFFFFF", "#A7B0C1", "#FFFFFF")),
    Frame("aurora", "Сияние", listOf("#3FA9F5", "#2EE6C8", "#E8F6FF", "#3FA9F5")),
    Frame("frost", "Иней", listOf("#BFE6FF", "#FFFFFF", "#6FB6FF", "#BFE6FF")),
    Frame("ember", "Пламя", listOf("#FF4D3A", "#FFC24B", "#FF2E63", "#FF4D3A")),
    Frame("emerald", "Изумруд", listOf("#0BAA6F", "#8CF7CF", "#0B6450", "#0BAA6F")),
    Frame("prism", "Призма", listOf("#4F8CFF", "#2EE6C8", "#FFE066", "#FF6B8A", "#4F8CFF")),
    Frame("orbit", "Орбита", listOf("#16316A", "#4F8CFF", "#16316A", "#16316A")),
  )

  /** Animated frames drawn in code (CodeFrames.tsx CODE_FRAMES). */
  val codeFrames = listOf(
    Item("fx-neon", "Неон"), Item("fx-flame", "Пламя"), Item("fx-stardust", "Звёзды"), Item("fx-glitch", "Глитч"),
    Item("fx-aurora", "Сияние"), Item("fx-lightning", "Молнии"), Item("fx-hearts", "Сердца"), Item("fx-orbit", "Орбиты"),
  )
  /** How far a code frame reaches past the avatar. */
  const val codeFrameScale = 1.3f

  val decorationCollections = listOf("Готика", "Хоррор", "Пламя", "Ночь")

  /** Hand-painted art around a round avatar (Decorations.tsx DECORATIONS); the files are mobile/assets/decorations
   *  (res/drawable-nodpi/decoration_*.webp). */
  val decorations = listOf(
    Decoration("deco-black-roses", "Чёрные розы", "Готика", "decoration_black_roses", 1.282f, true, "", "", false),
    Decoration("deco-white-roses", "Белые розы", "Готика", "decoration_white_roses", 1.272f, true, "", "#F1E9FF", false),
    Decoration("deco-chrome", "Хром", "Готика", "decoration_chrome", 1.5f, true, "", "", false),
    Decoration("deco-fangs", "Пасть", "Хоррор", "decoration_fangs", 1.267f, true, "", "", false),
    Decoration("deco-eye", "Глаз", "Хоррор", "decoration_eye", 1.5f, true, "", "", false),
    Decoration("deco-ink", "Чернила", "Хоррор", "decoration_ink", 1.292f, false, "#B9C0CC", "", false),
    Decoration("deco-skulls", "Черепа", "Пламя", "decoration_skulls", 1.332f, false, "#2FE6FF", "#8CF4FF", true),
    Decoration("deco-eclipse", "Затмение", "Пламя", "decoration_eclipse_smoke", 1.244f, false, "#FF6A1F", "#FFB35C", true),
    Decoration("deco-corona", "Корона", "Пламя", "decoration_corona", 1.5f, false, "#FFC13B", "#FFE08A", true),
    Decoration("deco-moon", "Лунная ночь", "Ночь", "decoration_lavender", 1.482f, false, "#B48CFF", "#F0E6FF", false),
    Decoration("deco-moths", "Мотыльки", "Ночь", "decoration_moths", 1.5f, false, "#C7A8FF", "#FFFFFF", false),
    Decoration("deco-arch", "Арка", "Ночь", "decoration_arch", 1.335f, true, "", "#FFE7A3", false),
  )

  /** Animated banner presets (Decor.tsx BANNERS); the colours are the music ambient's palettes. */
  val banners = listOf(Item("deep", "Глубина"), Item("glacier", "Ледник"), Item("aurora", "Сияние"), Item("ocean", "Океан"), Item("mint", "Мята"), Item("night", "Ночь"))

  /** Profile effects (Effects.tsx PROFILE_EFFECTS). */
  val effects = listOf(Item("snow", "Снег"), Item("sparks", "Искры"), Item("petals", "Лепестки"), Item("bubbles", "Пузырьки"), Item("stars", "Звёзды"), Item("embers", "Угольки"))

  /** Nameplates (Nameplates.tsx NAMEPLATES). */
  val plates = listOf(
    Plate("crows", "Вороны", "#2B2F36" to "#69717E"), Plate("leopard", "Барс", "#3A3A3E" to "#A4A4AA"),
    Plate("sparkle", "Блеск", "#0B0B12" to "#3E3858"), Plate("deep", "Глубина", "#06122E" to "#1D4596"),
    Plate("aurora", "Сияние", "#040A16" to "#0E2A3A"), Plate("ember", "Пламя", "#1A0603" to "#5E1606"),
    Plate("night", "Ночь", "#070616" to "#2A1C66"), Plate("sakura", "Сакура", "#24091A" to "#6E2249"),
    Plate("mint", "Мята", "#03201A" to "#0F5C46"), Plate("platinum", "Платина", "#22262E" to "#8E97A8"),
  )

  /** The emoji a status may be (statusEmojiModel.ts STATIC_STATUS_EMOJI). */
  val statusEmoji = listOf("✨", "⭐", "🌙", "☀️", "🌊", "🌿", "🔥", "💎", "🪐", "🎧", "🎮", "🦋", "🌛", "🌞", "🎶", "👾", "⚡", "❄️", "🌈", "👑")

  /** Background patterns of the profile header (ProfilePosts.tsx PROFILE_PATTERNS). */
  val patterns = listOf("⭐", "❤️", "🌸", "🔥", "🌙", "⚡", "🍀", "🎵", "👑", "💎", "🦋", "🐾", "☁️", "❄️", "🌊", "🍒", "👻", "💀", "🎮", "🚀", "🌈", "🍕", "🐱", "🦊")

  fun frame(id: String): Frame? = frames.firstOrNull { it.id == id }
  fun decoration(id: String): Decoration? = if (id.isEmpty()) null else decorations.firstOrNull { it.id == id }
  fun isCodeFrame(id: String): Boolean = id.isNotEmpty() && codeFrames.any { it.id == id }
  fun plate(id: String): Plate? = plates.firstOrNull { it.id == id }

  /** Festive ring colours for a birthday: blue (male), pink (female), or bright confetti (Decor.tsx birthdayColors). */
  fun birthdayColors(gender: String): List<String> = when (gender) {
    "male" -> listOf("#2F7BFF", "#7CC4FF", "#BFE6FF", "#4A8CFF", "#2F7BFF")
    "female" -> listOf("#FF5FA2", "#FFB3D6", "#FFD6E9", "#FF7EB8", "#FF5FA2")
    else -> listOf("#FF5F6D", "#FFC371", "#7CE38B", "#5FA8FF", "#C38BFF", "#FF5F6D")
  }

  /** The ring a person wears now: their birthday's, their chosen frame, or the platinum one for Platina without a
   *  choice (Decor.tsx). Null: no ring (no frame, or the frame is art or drawn in code). */
  fun ringColors(look: PersonLook, today: LocalDate = LocalDate.now()): List<String>? {
    if (look.birthdayToday(today)) return birthdayColors(look.gender)
    val id = look.avatarFrame.ifEmpty { if (look.platina) "platinum" else "" }
    return frame(id)?.colors
  }

  // Birthdays (birthday.ts)

  private fun dayIn(month: Int, day: Int, year: Int): Int = if (month == 2 && day == 29 && BirthdayWords.daysInMonth(2, year) == 28) 28 else day

  /** Is it this person's birthday today (on this phone's calendar)? 29 Feb is celebrated on 28 Feb in other years. */
  fun isBirthdayToday(value: String, today: LocalDate = LocalDate.now()): Boolean {
    val made = BirthdayWords.parse(value)?.takeIf { it.month in 1..12 } ?: return false
    return today.monthValue == made.month && today.dayOfMonth == dayIn(made.month, made.day, today.year)
  }

  /** The next local day of this birthday, today included. */
  fun nextBirthday(value: String, today: LocalDate = LocalDate.now()): LocalDate? {
    val made = BirthdayWords.parse(value)?.takeIf { it.month in 1..12 } ?: return null
    fun at(year: Int): LocalDate? = try { LocalDate.of(year, made.month, dayIn(made.month, made.day, year).coerceAtMost(BirthdayWords.daysInMonth(made.month, year))) } catch (_: Exception) { null }
    val thisYear = at(today.year)
    if (thisYear != null && !thisYear.isBefore(today)) return thisYear
    return at(today.year + 1)
  }

  @Suppress("unused")
  private val zone: ZoneId get() = ZoneId.systemDefault()
}
