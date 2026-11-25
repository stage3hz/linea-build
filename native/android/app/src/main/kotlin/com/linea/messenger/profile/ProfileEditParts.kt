package com.linea.messenger.profile

import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.titled
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.platina.ProfileHeroCard
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.ownProfile

/** The top of the profile editor (the reference's ProfileScreen.tsx editing; iOS Profile/ProfileEditParts.swift): the
 *  banner tile and the avatar, each with a camera badge, tapped to change; «Изменить фотографию» and «Фото, GIF или
 *  видео до 10 секунд». */
class ProfileEditTop(context: Context) : FrameLayout(context) {
  val banner = FrameLayout(context)
  val art = ProfileBannerView(context)
  val avatar = DecoratedAvatarView(context)
  val words: TextView = context.words("Изменить фотографию", 15f, Theme.accent, 600)

  init {
    clipChildren = false
    banner.background = context.plate(Theme.surface2, 24f)
    banner.clipToOutline = true
    banner.contentDescription = "Изменить баннер"
    banner.isClickable = true
    val placeholder = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
    placeholder.addView(ProfileIconView(context, "ion:image-outline", 24f, Theme.muted), LinearLayout.LayoutParams(context.px(24f), context.px(24f)))
    placeholder.addView(context.words("Баннер", 13f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f) })
    banner.addView(placeholder, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    banner.addView(art, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    banner.addView(badge(34f, 0x73000000, Color.WHITE, null), LayoutParams(context.px(34f), context.px(34f), Gravity.TOP or Gravity.END).apply { topMargin = context.px(12f); rightMargin = context.px(12f) })
    addView(banner, LayoutParams(LayoutParams.MATCH_PARENT, context.px(150f)).apply { topMargin = context.px(4f) })

    val ring = FrameLayout(context)
    ring.clipChildren = false
    ring.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.bg) }
    avatar.contentDescription = "Изменить фото профиля"
    avatar.ringBackground = Theme.bg
    avatar.isClickable = true
    ring.addView(avatar, LayoutParams(context.px(96f), context.px(96f), Gravity.CENTER))
    ring.addView(badge(32f, Theme.accent, Theme.onAccent, Theme.bg), LayoutParams(context.px(32f), context.px(32f), Gravity.BOTTOM or Gravity.END).apply { rightMargin = context.px(2f); bottomMargin = context.px(2f) })
    addView(ring, LayoutParams(context.px(106f), context.px(106f), Gravity.CENTER_HORIZONTAL).apply { topMargin = context.px(4f + 150f - 52f) })
    words.gravity = Gravity.CENTER
    words.isClickable = true
    words.setPadding(context.px(8f), context.px(6f), context.px(8f), context.px(4f))
    addView(words, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL).apply { topMargin = context.px(4f + 150f - 52f + 106f) })
    val hint = context.words("Фото, GIF или видео до 10 секунд", 12f, Theme.muted)
    hint.gravity = Gravity.CENTER
    addView(hint, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f + 150f - 52f + 106f + 30f); bottomMargin = context.px(4f) })
  }

  private fun badge(size: Float, fill: Int, tint: Int, border: Int?): View = FrameLayout(context).apply {
    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(fill); if (border != null) setStroke(context.px(2f), border) }
    // «camera-outline» 18 on the banner, 16 on the avatar.
    addView(ProfileIconView(context, "ion:camera-outline", if (size >= 34f) 18f else 16f, tint), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  companion object {
    /** A card around a part of the editor (the reference's glass card, `GlassSurface radius={22}`, padding 16). */
    fun card(inner: View): View = com.linea.messenger.settings.SettingsLook.glassCard(inner.context, listOf(inner), radius = 22f, padding = 16f)
  }
}

/** A sheet at the bottom of the screen with a scrolling column (the profile editor's pickers). */
abstract class ProfileSheet(context: Context) : Dialog(context) {
  protected val column = LinearLayout(context)
  protected val d = context.resources.displayMetrics.density

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(context.px(20f), context.px(28f), context.px(20f), context.px(24f))
    column.background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(28 * d, 28 * d, 28 * d, 28 * d, 0f, 0f, 0f, 0f) }
    val scroll = ScrollView(context).apply { addView(column); isVerticalScrollBarEnabled = false }
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
      com.linea.messenger.design.sheetWindow(this, column) // the sheet's colour to the screen's bottom, under the bar
    }
  }

  protected fun heading(text: String): TextView = TextView(context).apply { this.text = text; setTextColor(Theme.text); titled(Theme.TypeSize.sheetTitle) }

  protected fun add(view: View, gap: Float) = column.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { if (column.childCount > 0) topMargin = context.px(gap) })
}

/** «Так будет выглядеть профиль»: a banner photo on the profile's head before it is uploaded. */
class BannerPreview(context: Context, messenger: Messenger?, picture: Bitmap, sample: Person? = null) : ProfileSheet(context) {
  var onSet: (() -> Unit)? = null
  var onAgain: (() -> Unit)? = null

  init {
    add(heading("Так будет выглядеть профиль").apply { maxLines = 2 }, 0f)
    // Whose head: the account's; without one (the emulator check) the sample's, as the iPhone (`sample`).
    val person = messenger?.let { Person.from(it.ownProfile) } ?: sample ?: Person("", "", "", "", "", 0x5E7BFF, "")
    val hero = ProfileHeroCard(context)
    hero.show(person, person.look, messenger?.server?.endpoint ?: "", localPicture = picture)
    add(hero, 16f)
    val set = SettingsButton(context, "Установить баннер", icon = "checkmark")
    set.onPress = { dismiss(); onSet?.invoke() }
    add(set, 12f)
    val again = SettingsButton(context, "Выбрать другое", SettingsButton.Kind.SECONDARY, icon = "image-outline")
    again.onPress = { dismiss(); onAgain?.invoke() }
    add(again, 12f)
  }
}
