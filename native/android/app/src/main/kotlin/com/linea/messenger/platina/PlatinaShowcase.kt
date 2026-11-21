package com.linea.messenger.platina

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaButton
import com.linea.messenger.avatars.PlatinaMetal
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.profile.ProfileAmbientView
import com.linea.messenger.profile.ProfileBannerView
import com.linea.messenger.profile.ProfileEffectView
import com.linea.messenger.profile.ProfileIconView
import com.linea.messenger.profile.pages
import com.linea.messenger.settings.ownProfile

/** «Вот так будешь выглядеть ты» (the reference's platina/PlatinaShowcase.tsx; iOS Platina/PlatinaShowcase.swift): the
 *  viewer's own profile already dressed in Platina, then what it includes. Opens from any seal or platinum name, from
 *  the offer in Settings. Always dark, as the reference. */
object PlatinaShowcase {
  private var shown: java.lang.ref.WeakReference<Dialog>? = null

  /** Opens the showcase over whatever is on screen. `owner`: whose seal was tapped (someone else's: «У … — Platina»). */
  fun open(from: View, owner: Pair<String, String>? = null) {
    if (shown?.get()?.isShowing == true) return
    val made = PlatinaShowcaseSheet(from.context, from, owner)
    shown = java.lang.ref.WeakReference(made)
    made.show()
  }

  val perks = listOf(
    Triple("video", "Живой аватар", "Видео до 10 секунд вместо фото"),
    Triple("minus.circle", "Рамки", "Платиновая и ещё шесть анимированных"),
    Triple("photo", "Живой баннер", "Фото, видео или анимация над профилем"),
    Triple("sparkles", "Эффект профиля", "Снег, искры, лепестки — когда открывают твой профиль"),
    Triple("archive", "Табличка", "Фон за именем в чатах и списках участников"),
    Triple("gem", "Платиновое имя и печать", "Видно в чатах, каналах и на серверах"),
    Triple("sparkles", "Анимированные эмодзи", "Статус у имени и большие эмодзи в чатах"),
    Triple("pencil", "Цветовые темы", "Семь палитр: Аметист, Кофе, Олива, Сумерки, Лагуна, Индиго, Неон"),
    Triple("lock", "Невидимка", "Скрыть время захода и прочтения"),
    Triple("info", "Смена @имени", "Дополнительные смены публичного имени"),
  )
}

class PlatinaShowcaseSheet(context: Context, private val from: View, private val owner: Pair<String, String>?) : Dialog(context) {
  private val text = 0xFFEEF1F6.toInt()
  private val muted = 0xFF8B93A3.toInt()
  private val card = 0xFF101217.toInt()
  private val button = PlatinaButton(context, "Попробовать Platina", 16f, 18f)
  private val note = context.words("", 12f, muted)
  private var noteShown = false
  private val changed: (Unit) -> Unit = { refresh() }

  /** The account's own profile and its server (the debug build's sample person without an account). */
  private val me: Triple<Person, PersonLook, String>
    get() {
      val messenger = PlatinaState.messenger
      val raw = messenger?.ownProfile ?: PlatinaSamples.me?.invoke() ?: emptyMap()
      val person = Person.from(raw) ?: Person("", "", "", "", "", 0x5E7BFF, "")
      return Triple(person, person.look, messenger?.server?.endpoint ?: "")
    }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val d = context.resources.displayMetrics.density
    val root = FrameLayout(context)
    root.background = GradientDrawable().apply { setColor(0xFF06070A.toInt()); cornerRadii = floatArrayOf(30 * d, 30 * d, 30 * d, 30 * d, 0f, 0f, 0f, 0f) }
    val scroll = ScrollView(context).apply { isVerticalScrollBarEnabled = false }
    val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(context.px(16f), context.px(60f), context.px(16f), context.px(40f)) }
    scroll.addView(column)
    root.addView(scroll)
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    val (person, look, base) = me
    val lead = context.words(if (owner != null && owner.first != person.id) "У ${owner.second} — Platina. А вот так будешь выглядеть ты:" else "Так твой профиль увидят другие", 13f, muted)
    lead.gravity = Gravity.CENTER
    column.addView(lead, LinearLayout.LayoutParams(wide, wrap))
    column.addView(preview(person, look, base), LinearLayout.LayoutParams(wide, context.px(248f)).apply { topMargin = context.px(12f) })
    val brand = PlatinaNameView(context)
    brand.onDark = true
    brand.textSize = 30f
    brand.typeface = com.linea.messenger.design.Theme.weight(800)
    brand.letterSpacing = -0.02f
    brand.show("Инвиз Platina", platina = true)
    column.addView(brand, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = context.px(28f) })
    val pitch = context.words("Профиль, который заметят. Всё, что ниже, и всё, что появится дальше.", 14f, muted)
    pitch.gravity = Gravity.CENTER
    column.addView(pitch, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(8f); leftMargin = context.px(12f); rightMargin = context.px(12f) })
    val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; background = context.plate(card, 20f); setPadding(0, context.px(6f), 0, context.px(6f)) }
    PlatinaShowcase.perks.forEachIndexed { index, perk -> list.addView(perkRow(perk, index == 0)) }
    column.addView(list, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(22f) })
    button.setOnClickListener { tryPressed() }
    column.addView(button, LinearLayout.LayoutParams(wide, context.px(54f)).apply { topMargin = context.px(24f) })
    note.gravity = Gravity.CENTER
    column.addView(note, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(10f) })
    val close = ProfileIconView(context, "cross", 17f, Color.WHITE)
    close.background = context.plate(0x29FFFFFF, 22f)
    close.contentDescription = "Закрыть"
    close.isClickable = true
    close.setOnClickListener { dismiss() }
    root.addView(close, FrameLayout.LayoutParams(context.px(44f), context.px(44f), Gravity.END or Gravity.TOP).apply { topMargin = context.px(12f); rightMargin = context.px(16f) })
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      val height = (context.resources.displayMetrics.heightPixels * 0.94f).toInt()
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, height)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    PlatinaState.refresh()
    refresh()
  }

  override fun onStart() { super.onStart(); PlatinaState.changed.watch(changed) }
  override fun onStop() { PlatinaState.changed.unwatch(changed); super.onStop() }

  private fun preview(person: Person, look: PersonLook, base: String): View {
    val c = context
    val dressed = look.dressed()
    val box = FrameLayout(c)
    box.background = c.plate(card, 26f)
    box.clipToOutline = true
    val top = FrameLayout(c)
    if (look.hasBanner) top.addView(ProfileBannerView(c).apply { show(look, base) })
    else top.addView(ProfileAmbientView(c).apply { show("deep", still = !AvatarMotion.enabled(c)) })
    val shade = View(c)
    shade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(card and 0xFFFFFF, card and 0xFFFFFF, card))
    top.addView(shade, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    box.addView(top, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, c.px(120f)))
    box.addView(ProfileEffectView(c).apply { show(dressed.profileEffect) }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, c.px(200f)))
    val ring = FrameLayout(c)
    ring.clipChildren = false
    ring.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(card) }
    val avatar = DecoratedAvatarView(c)
    avatar.ringBackground = card
    avatar.show(person, dressed, base, animated = true)
    ring.addView(avatar, FrameLayout.LayoutParams(c.px(78f), c.px(78f), Gravity.CENTER))
    box.clipChildren = false
    box.addView(ring, FrameLayout.LayoutParams(c.px(88f), c.px(88f)).apply { leftMargin = c.px(18f); topMargin = c.px(120f - 46f) })
    val name = PlatinaNameView(c)
    name.onDark = true
    name.textSize = 24f
    name.typeface = com.linea.messenger.design.Theme.weight(800)
    name.show(person.displayName, platina = true)
    box.addView(name, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, c.px(30f)).apply { leftMargin = c.px(18f); rightMargin = c.px(18f); topMargin = c.px(120f - 46f + 88f + 10f) })
    val line = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    line.addView(c.words(if (person.username.isEmpty()) "" else "@" + person.username, 14f, muted))
    line.addView(PlatinaSealView(c).apply { onPress = {} }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = c.px(8f) })
    box.addView(line, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, c.px(22f)).apply { leftMargin = c.px(18f); topMargin = c.px(120f - 46f + 88f + 10f + 30f + 6f) })
    return box
  }

  private fun perkRow(perk: Triple<String, String, String>, first: Boolean): View {
    val c = context
    val row = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
    if (!first) row.addView(View(c).apply { setBackgroundColor(0x14FFFFFF) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxOf(1, c.px(0.5f))))
    val line = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(c.px(16f), c.px(11f), c.px(16f), c.px(11f)) }
    val icon = FrameLayout(c)
    icon.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, PlatinaMetal.platinum.map { lookColor(it) }.toIntArray()).apply { cornerRadius = 11f * c.resources.displayMetrics.density }
    icon.addView(ProfileIconView(c, perk.first, 15f, 0xFF1A1F2A.toInt()), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    line.addView(icon, LinearLayout.LayoutParams(c.px(34f), c.px(34f)))
    val texts = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
    texts.addView(c.words(perk.second, 15f, text, 600))
    texts.addView(c.words(perk.third, 12.5f, muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(2f) })
    line.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = c.px(14f) })
    row.addView(line)
    return row
  }

  private fun refresh() {
    val active = PlatinaState.active
    button.text = if (active) "Настроить оформление" else "Попробовать Platina"
    button.contentDescription = button.text
    if (noteShown) { note.text = "Покупка в приложении скоро появится. Сейчас Platina выдаёт администратор сервера."; note.textSize = 13f }
    else { note.text = if (active) "Platina уже активна" else "Отменить можно в любой момент"; note.textSize = 12f }
  }

  private fun tryPressed() {
    button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    val messenger = PlatinaState.messenger
    if (PlatinaState.active && messenger != null) {
      dismiss()
      from.pages()?.push(PlatinaStudioScreen(context, messenger))
      return
    }
    noteShown = true
    refresh()
  }
}
