package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputFilter
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.titled
import com.linea.messenger.design.words

// Gifts (the reference's ProfilePosts.tsx: the «Подарки» tab and `GiftSheet`; iOS Profile/Gifts.swift): sixteen kinds a
// friend sends with a short note; they stand on the profile three in a row; the owner removes one by holding it.
// Seen by friends (the server decides, as for posts).

/** Sample gifts for the debug build (set by profile/ProfileSamples.kt of src/debug; null in a release build). */
object GiftSamples {
  var make: ((own: Boolean) -> List<ProfileGift>)? = null
}

/** The «Подарки» tab's content: the send button on someone else's profile, the grid, or the empty words. It loads
 *  the gifts itself and tells its owner how many there are (`onCount`) and that its height changed (`onHeight`). */
class GiftsPanel(context: Context) : LinearLayout(context) {
  private var messenger: Messenger? = null
  private var userId = ""
  private var own = false
  var gifts: List<ProfileGift> = emptyList()
    private set
  private var loaded = false
  private var problem = ""
  var onHeight: (() -> Unit)? = null
  var onCount: ((Int) -> Unit)? = null

  init { orientation = VERTICAL }

  fun attach(messenger: Messenger?, userId: String, own: Boolean) {
    this.messenger = messenger
    this.userId = userId
    this.own = own
    reload()
  }

  fun reload() {
    val messenger = messenger
    if (messenger == null) {
      GiftSamples.make?.let { gifts = it(own); loaded = true; rebuild() }
      return
    }
    val asked = userId
    messenger.profileGifts(asked) { result ->
      if (userId != asked) return@profileGifts
      loaded = true
      result.getOrNull()?.let { gifts = it.second }
      rebuild()
    }
  }

  private fun rebuild() {
    removeAllViews()
    val wide = LayoutParams.MATCH_PARENT; val wrap = LayoutParams.WRAP_CONTENT
    if (!own && userId.isNotEmpty()) {
      val send = context.words("🎁  Отправить подарок", 15f, Theme.accent, 600)
      send.gravity = Gravity.CENTER
      send.background = context.plate(Theme.surface2, 19f)
      send.setPadding(context.px(16f), 0, context.px(16f), 0)
      send.isClickable = true
      send.setOnClickListener { sendPressed() }
      addView(send, LayoutParams(wrap, context.px(38f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = context.px(12f) })
    }
    if (own && gifts.isNotEmpty()) addView(context.words("Удержи подарок, чтобы удалить его.", 12f, Theme.muted).apply { gravity = Gravity.CENTER }, LayoutParams(wide, wrap).apply { bottomMargin = context.px(12f) })
    if (problem.isNotEmpty()) addView(context.words(problem, 14f, Theme.danger).apply { gravity = Gravity.CENTER }, LayoutParams(wide, wrap).apply { bottomMargin = context.px(12f) })
    when {
      !loaded -> addView(ProgressBar(context).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(Theme.muted) }, LayoutParams(context.px(26f), context.px(26f)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = context.px(17f); bottomMargin = context.px(17f) })
      gifts.isEmpty() -> {
        addView(context.words("🎁", 54f, Theme.text).apply { gravity = Gravity.CENTER }, LayoutParams(wide, context.px(64f)).apply { topMargin = context.px(18f) })
        addView(TextView(context).apply { text = "Подарков пока нет…"; setTextColor(Theme.text); gravity = Gravity.CENTER; titled(Theme.TypeSize.emptyTitle) }, LayoutParams(wide, wrap).apply { topMargin = context.px(8f) })
        addView(context.words(if (own) "Здесь появятся подарки от друзей." else "Подари первым — подарок появится в профиле.", 14f, Theme.muted).apply { gravity = Gravity.CENTER }, LayoutParams(wide, wrap).apply { topMargin = context.px(8f); bottomMargin = context.px(18f); leftMargin = context.px(12f); rightMargin = context.px(12f) })
      }
      else -> {
        var row: LinearLayout? = null
        gifts.forEachIndexed { index, item ->
          if (index % 3 == 0) {
            row = LinearLayout(context).apply { orientation = HORIZONTAL }
            addView(row, LayoutParams(wide, wrap).apply { if (index > 0) topMargin = context.px(8f) })
          }
          val gift = GiftCatalog.gift(item.gift)
          val tile = GiftTileView(context, gift, item.sender?.displayName ?: gift.label, item.message, 42f)
          tile.contentDescription = gift.label + (item.sender?.let { " от " + it.displayName } ?: "")
          if (own) tile.setOnLongClickListener { held(item, tile); true }
          row?.addView(tile, LayoutParams(0, wrap, 1f).apply { if (index % 3 > 0) leftMargin = context.px(8f) })
        }
        val rest = (3 - gifts.size % 3) % 3
        repeat(rest) { row?.addView(View(context), LayoutParams(0, 1, 1f).apply { leftMargin = context.px(8f) }) }
      }
    }
    onCount?.invoke(gifts.size)
    onHeight?.invoke()
  }

  private fun sendPressed() {
    val sheet = GiftSheet(context, messenger, userId)
    sheet.onSent = { reload() }
    sheet.show()
  }

  private fun held(item: ProfileGift, tile: View) {
    tile.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle("Подарок").setMessage("Подарок удалится из профиля навсегда, вернуть его будет нельзя.")
      .setPositiveButton("Удалить подарок") { _, _ -> remove(item) }
      .setNegativeButton("Отмена", null).show()
  }

  private fun remove(item: ProfileGift) {
    val messenger = messenger
    if (messenger == null) { gifts = gifts.filter { it.id != item.id }; rebuild(); return }
    problem = ""
    messenger.removeGift(item.id) { error ->
      if (error != null) { problem = error.words.ifEmpty { "Не удалось убрать подарок." }; rebuild() } else reload()
    }
  }
}

/** One gift: its two colours, the emoji, who sent it (or its name) and the note. */
@SuppressLint("ViewConstructor")
class GiftTileView(context: Context, gift: GiftCatalog.Gift, title: String, note: String, emojiSize: Float) : LinearLayout(context) {
  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val big = emojiSize > 34
    val pad = context.px(if (big) 14f else 8f); val gap = context.px(if (big) 6f else 2f)
    background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(lookColor(gift.colors.first), lookColor(gift.colors.second))).apply { cornerRadius = 16f * resources.displayMetrics.density }
    setPadding(context.px(6f), pad, context.px(6f), pad)
    addView(context.words(gift.emoji, emojiSize, Theme.text).apply { gravity = Gravity.CENTER }, LayoutParams(LayoutParams.MATCH_PARENT, Math.round(emojiSize * 1.2f * resources.displayMetrics.density)))
    // The iPhone's label shrinks to fit (`adjustsFontSizeToFitWidth`, down to 0.75 of its size) before it cuts:
    // «Бриллиант», «Шампанское» stay whole.
    val titleSize = if (big) 12f else 10f
    addView(context.words(title, titleSize, 0xFFFFFFFF.toInt(), 700).apply {
      gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
      val most = Math.round(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, titleSize, resources.displayMetrics))
      setAutoSizeTextTypeUniformWithConfiguration(maxOf(1, Math.round(most * 0.75f)), maxOf(2, most), 1, android.util.TypedValue.COMPLEX_UNIT_PX)
    }, LayoutParams(LayoutParams.MATCH_PARENT, context.px(15f)).apply { topMargin = gap })
    if (note.isNotEmpty()) addView(context.words(note, 11f, 0xD9FFFFFF.toInt()).apply { gravity = Gravity.CENTER; maxLines = 2; ellipsize = TextUtils.TruncateAt.END }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = gap })
    isClickable = true
  }
}

/** Choose a gift for a friend, add a short note, send (the reference's `GiftSheet`). A sheet at the bottom. */
class GiftSheet(context: Context, private val messenger: Messenger?, private val userId: String) : Dialog(context) {
  var onSent: (() -> Unit)? = null
  private var picked = "bear"
  private var busy = false
  private val tiles = ArrayList<Pair<String, View>>()
  private val note = EditText(context)
  private val problem = context.words("", 13f, Theme.danger)
  /** The reference's standard `Button` (ProfilePosts.tsx GiftSheet; components.tsx): the main one, 54 tall. */
  private val send = com.linea.messenger.settings.SettingsButton(context, "Отправить подарок")
  private val d = context.resources.displayMetrics.density

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val stack = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(context.px(20f), context.px(28f), context.px(20f), context.px(24f))
      background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    stack.addView(TextView(context).apply { text = "Подарок"; setTextColor(Theme.text); titled(Theme.TypeSize.sheetTitle) })
    val grid = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    var row: LinearLayout? = null
    GiftCatalog.all.forEachIndexed { index, gift ->
      if (index % 4 == 0) { row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }; grid.addView(row, LinearLayout.LayoutParams(wrap, wrap).apply { if (index > 0) topMargin = context.px(8f) }) }
      val holder = FrameLayout(context)
      holder.setPadding(context.px(2f), context.px(2f), context.px(2f), context.px(2f))
      holder.contentDescription = gift.label
      holder.isClickable = true
      val tile = GiftTileView(context, gift, gift.label, "", 30f)
      tile.isClickable = false
      holder.addView(tile, FrameLayout.LayoutParams(context.px(66f), FrameLayout.LayoutParams.WRAP_CONTENT))
      holder.setOnClickListener { picked = gift.id; showPicked() }
      row?.addView(holder, LinearLayout.LayoutParams(context.px(70f), wrap).apply { if (index % 4 > 0) leftMargin = context.px(8f) })
      tiles.add(gift.id to holder)
    }
    stack.addView(grid, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    stack.addView(context.words("Подпись", 13f, Theme.muted, 500), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    note.hint = "Необязательно"
    note.textSize = 16f
    note.setTextColor(Theme.text)
    note.setHintTextColor(Theme.subtle)
    note.background = context.plate(Theme.surface2, 14f)
    note.setPadding(context.px(14f), 0, context.px(14f), 0)
    note.isSingleLine = true
    note.imeOptions = EditorInfo.IME_ACTION_DONE
    note.filters = arrayOf(InputFilter.LengthFilter(120))
    stack.addView(note, LinearLayout.LayoutParams(wide, context.px(48f)).apply { topMargin = context.px(6f) })
    stack.addView(problem, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    send.onPress = { sendNow() }
    stack.addView(send, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    val scroll = ScrollView(context).apply { addView(stack) }
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
      com.linea.messenger.design.sheetWindow(this, stack) // the sheet's colour to the screen's bottom, under the bar
    }
    showPicked()
  }

  private fun showPicked() {
    for ((id, holder) in tiles) {
      val on = id == picked
      holder.background = GradientDrawable().apply { cornerRadius = 16f * d; setStroke(Math.round(2 * d), if (on) Theme.accent else Color.TRANSPARENT) }
      holder.isSelected = on
    }
  }

  private fun sendNow() {
    if (busy) return
    val words = note.text.toString().trim()
    val messenger = messenger
    if (messenger == null) { dismiss(); onSent?.invoke(); return }
    busy = true
    problem.text = ""
    send.setBusy(true)
    messenger.sendGift(userId, picked, words) { error ->
      busy = false
      send.setBusy(false)
      if (error != null) { problem.text = error.words.ifEmpty { "Не удалось отправить подарок." }; return@sendGift }
      send.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      dismiss()
      onSent?.invoke()
    }
  }
}
