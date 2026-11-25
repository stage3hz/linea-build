package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.platina.PlatinaSamples
import com.linea.messenger.platina.PlatinaState
import com.linea.messenger.settings.MessengerAccount
import com.linea.messenger.settings.SettingsAccount
import com.linea.messenger.settings.OwnProfile
import com.linea.messenger.settings.ProfileEditScreen
import com.linea.messenger.shell.Screen

/** «Мой профиль» read-only, as others see it (the reference's ProfileScreen.tsx without «Изм.»; iOS
 *  Profile/OwnProfileViewController.swift): the banner or the light, the pattern, the decorated avatar with the ring of
 *  stories, the name with the emoji status (a tap opens the status picker), «в сети», the card, the posts, stories and
 *  gifts. Scrolling up, the photo shrinks away and the name settles small in the middle of the top row; a long pull
 *  opens the photo and video. «Изменить» opens the editor. */
@SuppressLint("ViewConstructor")
class OwnProfileScreen(context: Context, private val messenger: Messenger?, private val account: SettingsAccount? = messenger?.let { MessengerAccount(it) }) : Screen(context) {
  private val scroll = ScrollView(context)
  private val content = LinearLayout(context)
  private val hero = ProfileHeroView(context)
  private val topLayers = ProfileTopLayers(context)
  private val card = ProfileInfoCard(context)
  private val postsBlock = com.linea.messenger.stories.ProfilePostsBlock(context)
  private val noticeLabel = context.words("", 13f, Theme.accent)
  private val barBackdrop = View(context)
  private val back = IconButton(context, "ion:chevron-back", 23f, Theme.text) // IconButton «chevron-back», 23
  private val edit = context.words("Изменить", 16f, Theme.text, 600)
  private val smallName = context.words("", 16f, Theme.text, 700)
  private val smallStatus = context.words("в сети", 12f, Theme.muted)
  private val titleBox = LinearLayout(context)
  private var copied = false
  private var copyTurn = 0
  /** Opens the status picker as soon as the page shows (a tap on the status in Settings). */
  var opensStatusPicker = false
  private val profileChanged: () -> Unit = { refresh() }
  private val platinaChanged: (Unit) -> Unit = { refresh() }

  private val me: Person
    get() {
      val raw = account?.ownProfile ?: PlatinaSamples.me?.invoke() ?: emptyMap()
      return Person.from(raw) ?: Person("", "", "", "", "", 0x5E7BFF, "")
    }
  private val base: String get() = account?.base ?: ""

  /** The banner / light as a glass source: the round glass «назад» shows it blurred, as the iPhone's (without a source
   *  the round is the plain, nearly opaque fill). The layers are placed by `place`, not by this frame. */
  private val topStage = object : com.linea.messenger.design.GlassSource(context) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
  }

  init {
    setBackgroundColor(Theme.bg)
    isClickable = true
    topStage.addView(topLayers.back)
    topStage.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(topStage)
    scroll.isVerticalScrollBarEnabled = false
    scroll.clipChildren = false
    content.orientation = LinearLayout.VERTICAL
    content.clipChildren = false
    scroll.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    addView(scroll)
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    content.addView(hero, LinearLayout.LayoutParams(wide, wrap))
    hero.avatarHolder.setOnClickListener { avatarTapped() }
    hero.status.contentDescription = "Сменить статус рядом с именем"
    hero.onStatus = { y -> openStatusPicker(y) }
    card.onCopy = { copyUsername() }
    content.addView(card, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(31f) })
    content.addView(postsBlock, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(17f) })
    noticeLabel.gravity = Gravity.CENTER
    noticeLabel.visibility = View.GONE
    content.addView(noticeLabel, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(17f) })
    postsBlock.attach(this, messenger, account?.userId ?: me.id, own = true, avatar = hero.avatar)
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> layoutTop() }

    addView(topLayers.front)
    barBackdrop.setBackgroundColor(Theme.bg)
    barBackdrop.alpha = 0f
    addView(barBackdrop)
    com.linea.messenger.design.GlassBacking.put(back).source = topStage // C: the reference's IconButton — a round of clear glass
    back.contentDescription = "Назад"
    back.setOnClickListener { pagesStack()?.pop() }
    addView(back)
    edit.gravity = Gravity.CENTER
    edit.setPadding(dp(17f), 0, dp(17f), 0)
    edit.contentDescription = "Изменить профиль"
    edit.isClickable = true
    edit.setOnClickListener { editPressed() }
    addView(edit)
    titleBox.orientation = LinearLayout.VERTICAL
    titleBox.gravity = Gravity.CENTER
    smallName.gravity = Gravity.CENTER; smallName.maxLines = 1
    smallStatus.gravity = Gravity.CENTER
    titleBox.addView(smallName); titleBox.addView(smallStatus)
    titleBox.alpha = 0f
    addView(titleBox)
    refresh()
  }

  private fun pagesStack() = (this as View).pages()

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    OwnProfile.watch(profileChanged)
    PlatinaState.changed.watch(platinaChanged)
    account?.prepareSettingsAvatars()
    account?.refreshOwnProfile()
    PlatinaState.refresh()
    post {
      topLayers.celebrate(this)
      if (opensStatusPicker) {
        opensStatusPicker = false
        val place = IntArray(2); hero.getLocationOnScreen(place)
        openStatusPicker(place[1] + hero.height - dp(60f))
      }
    }
  }

  override fun onDetachedFromWindow() {
    OwnProfile.unwatch(profileChanged)
    PlatinaState.changed.unwatch(platinaChanged)
    super.onDetachedFromWindow()
  }

  private fun refresh() {
    val person = me
    topLayers.show(person, base)
    val tinted = topLayers.tinted
    hero.show(person, base, "в сети", tinted)
    smallName.text = person.displayName
    edit.background = context.plate(if (tinted) 0x47000000 else Theme.surface2, 22f)
    edit.setTextColor(if (tinted) 0xFFFFFFFF.toInt() else Theme.text)
    card.show(person.username, person.birthday, person.bio, copied)
    postsBlock.setColor(person.avatarColor)
    requestLayout()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val padTop = top + dp(60f + 8f)
    if (content.paddingTop != padTop || content.paddingBottom != dp(36f) + edges.bottom) content.setPadding(dp(17f), padTop, dp(17f), dp(36f) + edges.bottom)
    put(scroll, 0, 0, width, height)
    put(topStage, 0, 0, width, topLayers.backHeight(hero.bottom))
    put(topLayers.back, 0, 0, width, topLayers.backHeight(hero.bottom))
    put(topLayers.front, 0, 0, width, topLayers.frontHeight())
    put(barBackdrop, 0, 0, width, top + dp(8f + 52f + 12f))
    put(back, dp(12f), top + dp(8f + 4f), dp(44f), dp(44f))
    edit.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(dp(44f), MeasureSpec.EXACTLY))
    put(edit, width - dp(12f) - edit.measuredWidth, top + dp(12f), edit.measuredWidth, dp(44f))
    val boxWidth = width - dp(12f + 44f + 10f) * 2 - edit.measuredWidth + dp(44f)
    titleBox.measure(MeasureSpec.makeMeasureSpec(maxOf(0, boxWidth), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    put(titleBox, (width - titleBox.measuredWidth) / 2, top + dp(8f) + (dp(52f) - titleBox.measuredHeight) / 2, titleBox.measuredWidth, titleBox.measuredHeight)
    layoutTop()
  }

  private var pulled = 0
  private var pullStart = -1f

  private fun layoutTop() {
    val scrolled = scroll.scrollY - pulled
    val heroBottom = hero.bottom
    topLayers.layout(width, edges.top, scrolled, heroBottom)
    hero.applyScroll(scrolled)
    fun fade(from: Int, to: Int): Float = ((scrolled - from).toFloat() / maxOf(1, to - from)).coerceIn(0f, 1f)
    barBackdrop.alpha = fade(heroBottom - dp(80f), heroBottom - dp(40f)) * 0.96f
    titleBox.alpha = fade(heroBottom - dp(60f), heroBottom - dp(30f))
    titleBox.translationY = dp(8f) * (1 - titleBox.alpha)
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> pullStart = if (scroll.scrollY == 0) event.rawY else -1f
      MotionEvent.ACTION_MOVE -> if (pullStart >= 0 && scroll.scrollY == 0) {
        val next = maxOf(0, ((event.rawY - pullStart) * 0.5f).toInt())
        if (next != pulled) { pulled = next; layoutTop() }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (pulled > dp(110f)) post { openMedia() }
        if (pulled != 0) { pulled = 0; layoutTop() }
        pullStart = -1f
      }
    }
    return super.dispatchTouchEvent(event)
  }

  private fun editPressed() {
    val account = account ?: return
    pagesStack()?.push(ProfileEditScreen(context, account))
  }

  private fun avatarTapped() {
    if (postsBlock.openStoriesIfAny()) return
    openMedia()
  }

  private fun openMedia() {
    val person = me
    if (ProfileMediaViewer.items(person).isEmpty()) return
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    ProfileMediaViewer(context, person, base).show()
  }

  private fun copyUsername() {
    val handle = me.username
    if (handle.isEmpty()) return
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("", "@$handle"))
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    copied = true
    copyTurn += 1
    val turn = copyTurn
    refresh()
    postDelayed({ if (copyTurn == turn) { copied = false; refresh() } }, 1800)
  }

  private fun say(words: String) {
    noticeLabel.text = words
    noticeLabel.visibility = if (words.isEmpty()) View.GONE else View.VISIBLE
    if (words.isEmpty()) return
    postDelayed({ if (noticeLabel.text.toString() == words) say("") }, 3500)
  }

  /** Opens the status picker under the name (`anchorY`: where the name ends on the screen, px). */
  fun openStatusPicker(anchorY: Int) {
    val picker = StatusPicker(context, anchorY, PlatinaState.status.ifEmpty { if (messenger == null) samplesStatus() else emptyMap() }, me.look.visibleStatus())
    picker.onPick = { emoji -> applyStatus(emoji) }
    picker.show()
  }

  private fun samplesStatus(): Map<String, Any?> = mapOf("platina" to mapOf("active" to true), "canSetStatusEmoji" to true, "statusEmojiChoices" to com.linea.messenger.avatars.AvatarCatalog.statusEmoji)

  private fun applyStatus(emoji: String?) {
    val messenger = messenger ?: return say(if (emoji == null) "Статус убран." else "Статус обновлён.")
    messenger.changeStatusEmoji(emoji) { result ->
      if (result.isSuccess) say(if (emoji == null) "Статус убран." else "Статус обновлён.")
      else { say(com.linea.messenger.net.Server.error(result).words.ifEmpty { "Не удалось изменить статус." }); PlatinaState.refresh(force = true) }
    }
  }
}
