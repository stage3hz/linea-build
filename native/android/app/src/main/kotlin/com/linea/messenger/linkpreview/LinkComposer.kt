package com.linea.messenger.linkpreview

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.chatactions.GlassBar
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme

/** The card of a link above the field while a message is being written: the page's site and title (and its
 *  picture, small), with a cross that drops the card for this message. */
@SuppressLint("ViewConstructor")
class LinkComposerCard(context: Context) : GlassBar(context, 22f) {
  private val stripe = View(context).apply { background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 1.5f * d } }
  private val siteLabel = line(12f, Theme.accent, 700)
  private val titleLabel = line(13f, Theme.muted)
  private val picture = ImageView(context).apply {
    scaleType = ImageView.ScaleType.CENTER_CROP
    visibility = View.GONE
    clipToOutline = true
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, 8f * d)
    }
  }
  private val closeButton = ChatIconView(context, "xmark", 14f, Theme.muted).apply {
    isClickable = true; isFocusable = true
    contentDescription = "Не прикладывать предпросмотр ссылки"
  }
  var onClose: (() -> Unit)? = null

  init {
    addView(stripe); addView(siteLabel); addView(titleLabel); addView(picture); addView(closeButton)
    closeButton.setOnClickListener { onClose?.invoke() }
  }

  /** Shows a card as `encrypt` will take it. */
  fun show(card: Map<String, Any?>) {
    val shown = MsgLinkCard.parse(card)
    val site = shown?.site ?: ""
    val title = shown?.title ?: ""
    siteLabel.text = site
    // A page without a title of its own: its description stands in.
    titleLabel.text = title.ifEmpty { shown?.about ?: "" }
    val image = shown?.picture()
    picture.setImageBitmap(image)
    picture.visibility = if (image == null) View.GONE else View.VISIBLE
    siteLabel.contentDescription = "Предпросмотр ссылки: $site"
    requestLayout()
  }

  /** What the card says now (for the checks). */
  val site: String get() = siteLabel.text.toString()
  val title: String get() = titleLabel.text.toString()
  val hasPicture: Boolean get() = picture.visibility == View.VISIBLE
  /** The cross, as a finger presses it (for the checks). */
  fun close() { closeButton.performClick() }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    put(stripe, dp(16f), dp(10f), dp(3f), height - dp(20f))
    var edge = width - dp(44f)
    put(closeButton, edge, (height - dp(44f)) / 2, dp(44f), dp(44f))
    if (picture.visibility == View.VISIBLE) {
      edge -= dp(40f)
      put(picture, edge, (height - dp(36f)) / 2, dp(36f), dp(36f))
      edge -= dp(8f)
    }
    val textWidth = (edge - dp(28f)).coerceAtLeast(0)
    put(siteLabel, dp(28f), dp(11f), textWidth, dp(16f))
    put(titleLabel, dp(28f), dp(28f), textWidth, dp(17f))
  }

  companion object { const val height = 56f }
}

/** The link of the message being written and its card: asks the fetcher for it when typing stops, shows it above
 *  the field and hands it to the sending.
 *
 *  A page is fetched only for a link the person typed or pasted into this field themselves, and only while
 *  «Предпросмотр ссылок» is on: not for a draft put back into the field, not for an edit, not for forwarded text.
 *  Main thread only. */
class LinkComposer(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  val cardView = LinkComposerCard(context)
  private var waiting: Runnable? = null
  private var ticket: LinkFetcher.Ticket? = null
  /** The link the work in hand (or the card shown) is for. */
  private var link = ""
  /** The card ready to go with the message; null: none (yet). */
  private var card: Map<String, Any?>? = null
  /** The link whose card the person dropped with the cross: not offered again for this message. */
  private var dropped = ""
  /** A card is there to be shown (the view itself is also away while the composer is: `place`). */
  private var present = false
  /** The card appeared, changed or went: the screen places its views again. */
  var onChanged: (() -> Unit)? = null

  /** The fetcher's part, as a function (the checks put their own in its place: no request is made there). */
  var fetch: (url: String, done: (Map<String, Any?>?) -> Unit) -> LinkFetcher.Ticket = { url, done -> LinkFetcher.shared.card(context, url, done) }
  /** The core's `candidate`, as a function (for the checks without the core). */
  var candidate: (String) -> String? = { LinkCore.candidate(it) }

  init {
    cardView.visibility = View.GONE
    cardView.onClose = { drop() }
  }

  private fun activity(): Activity? {
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    return owner as? Activity
  }

  /** Adds the card to the chat's screen (it is placed by `place`). `behind`: the page its glass blurs. */
  fun install(host: ViewGroup, behind: GlassSource?) {
    cardView.behind = behind
    host.addView(cardView)
    // `--es linkdemo composer` (debug builds): the card above the field, as after typing a link (no request is made).
    val sample = LinkDemo.composerCard(activity()?.intent) ?: return
    link = sample["url"] as? String ?: ""
    card = sample
    cardView.show(sample)
    present = true
    cardView.visibility = View.VISIBLE
  }

  private fun stopWaiting() {
    waiting?.let { main.removeCallbacks(it) }
    waiting = null
  }

  /** The field's text changed by the person's own typing or pasting. `active`: the field is for a new message
   *  (not an edit, not the comment of a forward). */
  fun typed(text: String, active: Boolean) {
    stopWaiting()
    if (!active || !LinkSettings.on(context)) {
      clear(keepDropped = active)
      return
    }
    // Nothing that could be a link: no need to wait to take the card away.
    if (!mayHoldLink(text)) {
      clear(keepDropped = false)
      return
    }
    val work = Runnable { look(text) }
    waiting = work
    main.postDelayed(work, pause)
  }

  private fun look(text: String) {
    waiting = null
    val found = if (LinkSettings.on(context)) candidate(text) else null
    if (found == null) {
      clear(keepDropped = false)
      return
    }
    if (found == dropped) {
      clear(keepDropped = true)
      return
    }
    if (found == link) return
    clear(keepDropped = false)
    link = found
    ticket = fetch(found) { made ->
      if (link != found) return@fetch
      ticket = null
      if (made == null) return@fetch
      card = made
      cardView.show(made)
      present = true
      cardView.visibility = View.VISIBLE
      onChanged?.invoke()
    }
  }

  /** The cross: this message goes without a card, whatever is typed after the link. */
  private fun drop() {
    dropped = link
    clear(keepDropped = true)
  }

  private fun clear(keepDropped: Boolean) {
    ticket?.cancel()
    ticket = null
    link = ""
    card = null
    if (!keepDropped) dropped = ""
    if (present) {
      present = false
      cardView.visibility = View.GONE
      onChanged?.invoke()
    }
  }

  /** The card to send with this text, if one is ready and still belongs to it; the composer is then empty again. */
  fun take(text: String): Map<String, Any?>? {
    stopWaiting()
    var ready: Map<String, Any?>? = null
    val card = card
    if (card != null && link.isNotEmpty() && LinkSettings.on(context) && candidate(text) == link) ready = card
    clear(keepDropped = false)
    return ready
  }

  /** The field was emptied or given to something else (an edit, a forward). */
  fun reset() {
    stopWaiting()
    clear(keepDropped = false)
  }

  /** Whether the card stands above the field now. */
  val shown: Boolean get() = present

  /** Places the card above the composer (and above the bar of an answer, when there is one): `above` is the top
   *  of what already stands there, px. Gives the new top. `hidden`: the composer itself is not shown now. */
  fun place(composerLeft: Int, composerWidth: Int, above: Int, hidden: Boolean): Int {
    if (hidden || !present) {
      // Away with the composer (messages are being chosen): it must not take a touch it cannot be seen to take.
      cardView.visibility = View.GONE
      return above
    }
    cardView.visibility = View.VISIBLE
    val d = context.resources.displayMetrics.density
    val height = Math.round(LinkComposerCard.height * d); val top = above - Math.round(6f * d) - height
    cardView.measure(View.MeasureSpec.makeMeasureSpec(composerWidth.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
    cardView.layout(composerLeft, top, composerLeft + composerWidth.coerceAtLeast(0), top + height)
    return top
  }

  companion object {
    /** How long typing must stop before a page is asked for, ms. */
    const val pause = 600L

    /** Whether a text could hold a link at all (the core decides which; this only saves the wait). */
    fun mayHoldLink(text: String): Boolean = text.lowercase().let { it.contains("https://") || it.contains("www.") }
  }
}
