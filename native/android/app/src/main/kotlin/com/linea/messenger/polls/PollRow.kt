package com.linea.messenger.polls

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.chatactions.ChatIcons
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import kotlin.math.roundToInt

/** A poll inside a message (iOS: Sources/Polls/PollRow.swift; the reference's PollBubble.tsx): the question, «Опрос»
 *  or «Опрос · несколько ответов», the options — before voting a circle (or a square when several answers are
 *  allowed), after voting the share in per cent, a bar and a tick at what this person chose — «Голосовать» for
 *  several answers, and at the bottom how many voted with «Отменить голос».
 *
 *  The poll itself is `meta.poll` inside the encrypted message; a vote is an encrypted action (`meta.action`
 *  `{type: "vote", target, options}`) and the results are folded by the shared core (`foldChat` gives `poll`
 *  `{counts, mine, voters}`), exactly as on the other phone. */
data class MsgPoll(
  val question: String, val options: List<String>, val multiple: Boolean, val counts: List<Int>, val mine: List<Int>, val voters: Int,
  /** Options ticked but not sent yet (several answers). */
  val draft: List<Int>,
  /** Nothing can be chosen (a message on its way out, the multi-select). */
  val disabled: Boolean,
) {
  val voted: Boolean get() = mine.isNotEmpty()
  val total: Int get() = counts.sum()

  val spoken: String
    get() {
      val words = arrayListOf(question, if (multiple) "Опрос · несколько ответов" else "Опрос")
      options.forEachIndexed { index, option ->
        val count = counts.getOrElse(index) { 0 }
        words.add(if (voted) option + ", " + (if (total > 0) (count.toDouble() / total * 100).roundToInt() else 0) + "%" else option)
      }
      words.add(if (voters > 0) "$voters ${votes(voters)}" else "Пока нет голосов")
      return words.joinToString(". ")
    }

  companion object {
    /** The poll of a row (`row["poll"]`, made by `PollRows.fields`), or null. */
    fun parse(value: Any?): MsgPoll? {
      val map = Core.map(value as? Map<*, *>) ?: return null
      val question = map["question"] as? String ?: return null
      val options = (map["options"] as? List<*>)?.filterIsInstance<String>()?.takeIf { it.isNotEmpty() } ?: return null
      fun ints(key: String) = (map[key] as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toInt() }
      return MsgPoll(question, options, map["multiple"] == true, ints("counts"), ints("mine"), (map["voters"] as? Number)?.toInt() ?: 0, ints("draft"), map["disabled"] == true)
    }

    /** «1 голос», «3 голоса», «7 голосов». */
    fun votes(n: Int): String {
      if (n % 10 == 1 && n % 100 != 11) return "голос"
      if (n % 10 in 2..4 && (n % 100 < 10 || n % 100 >= 20)) return "голоса"
      return "голосов"
    }
  }
}

/** The poll fields of a row of the chat (made off the main thread by ChatHistory). */
object PollRows {
  /** `meta.poll` with the folded results (`message["poll"]`), the options ticked so far and whether it can be used. */
  fun fields(message: Map<String, Any?>, draft: List<Int>, disabled: Boolean): Map<String, Any?>? {
    val poll = Core.map(Core.map(message["meta"] as? Map<*, *>)?.get("poll") as? Map<*, *>) ?: return null
    val question = poll["question"] as? String ?: return null
    val options = (poll["options"] as? List<*>)?.filterIsInstance<String>() ?: return null
    val results = Core.map(message["poll"] as? Map<*, *>)
    return mapOf("question" to question, "options" to options, "multiple" to (poll["multiple"] == true),
      "counts" to (results?.get("counts") as? List<*>).orEmpty(), "mine" to (results?.get("mine") as? List<*>).orEmpty(),
      "voters" to ((results?.get("voters") as? Number)?.toInt() ?: 0), "draft" to draft, "disabled" to disabled)
  }
}

/** What a poll goes out with (the reference's messageMeta.ts `pollFallback`): the text a chat list or an older client
 *  shows — the question, then «1. option» lines — at most 8000 UTF-16 units. Without the reference's «📊» (the
 *  owner's rule: no emoji in the app's lines; the reference reads `meta.poll`, not this text). */
object PollText {
  fun fallback(poll: Map<String, Any?>): String {
    val lines = arrayListOf(poll["question"] as? String ?: "")
    (poll["options"] as? List<*>).orEmpty().filterIsInstance<String>().forEachIndexed { index, option -> lines.add("${index + 1}. $option") }
    val whole = lines.joinToString("\n")
    return if (whole.length <= 8000) whole else whole.substring(0, 8000)
  }
}

/** Where the parts of a poll go, for the width it is shown at (px; frames from the poll's own corner), and how it
 *  is drawn. */
class MsgPollLayout private constructor(val poll: MsgPoll, private val d: Float) {
  var width = 0f; private set
  var height = 0f; private set
  private var question: StaticLayout? = null
  private val optionRows = ArrayList<RectF>()
  private val optionTexts = ArrayList<StaticLayout>()
  private var voteRow: RectF? = null
  private var footerY = 0f
  private var retract: RectF? = null

  companion object {
    private val questionPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(700) }
    private val notePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(400) }
    private val optionPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(400) }
    private val sharePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(700) }
    private val votePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(700); textAlign = Paint.Align.CENTER }
    private val retractPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Theme.weight(400) }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    private fun lay(text: String, paint: TextPaint, width: Int): StaticLayout =
      StaticLayout.Builder.obtain(text, 0, text.length, paint, width.coerceAtLeast(1)).setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).build()

    /** `inner`: the room the message has, px. */
    fun make(poll: MsgPoll, inner: Float, d: Float): MsgPollLayout {
      questionPaint.textSize = 15 * d; notePaint.textSize = 11 * d; optionPaint.textSize = 14 * d; sharePaint.textSize = 13 * d; votePaint.textSize = 14 * d; retractPaint.textSize = 12 * d
      val made = MsgPollLayout(poll, d)
      // minWidth 230, maxWidth 290 — within the room the message has.
      val width = minOf(inner, 290 * d)
      var y = 2 * d
      made.question = lay(poll.question, questionPaint, width.toInt())
      y += (made.question?.height ?: 0) + 8 * d
      y += 14 * d + 8 * d
      val textWidth = width - (20 + 8 + 8 + 17) * d
      for (option in poll.options) {
        val text = lay(option, optionPaint, textWidth.toInt())
        val textHeight = maxOf(18 * d, text.height.toFloat())
        var rowHeight = 4 * d + maxOf(20 * d, textHeight) + 4 * d
        if (poll.voted) rowHeight += 8 * d
        made.optionRows.add(RectF(0f, y, width, y + rowHeight))
        made.optionTexts.add(text)
        y += rowHeight + 8 * d
      }
      if (poll.multiple && !poll.voted) {
        made.voteRow = RectF(0f, y, width, y + 34 * d)
        y += 34 * d + 8 * d
      }
      made.footerY = y
      if (poll.voted && !poll.disabled) {
        val words = retractPaint.measureText("Отменить голос")
        made.retract = RectF(width - words - 8 * d, y - 8 * d, width + 8 * d, y + 24 * d)
      }
      y += 18 * d
      made.width = maxOf(minOf(inner, 230 * d), width)
      made.height = y
      return made
    }
  }

  /** The part of the poll under a point (from the poll's corner): "option:<n>", "vote" or "retract". */
  fun part(x: Float, y: Float): String? {
    if (poll.disabled) return null
    retract?.let { if (it.contains(x, y)) return "retract" }
    voteRow?.let { if (it.contains(x, y)) return "vote" }
    optionRows.forEachIndexed { index, row -> if (row.contains(x, y)) return "option:$index" }
    return null
  }

  private fun text(canvas: Canvas, layout: StaticLayout, x: Float, y: Float) { canvas.save(); canvas.translate(x, y); layout.draw(canvas); canvas.restore() }

  fun draw(canvas: Canvas, x: Float, top: Float, palette: MsgPalette) {
    var y = top + 2 * d
    questionPaint.color = palette.text
    question?.let { text(canvas, it, x, y); y += it.height + 8 * d }
    notePaint.color = palette.muted
    canvas.drawText(if (poll.multiple) "Опрос · несколько ответов" else "Опрос", x, y - notePaint.ascent(), notePaint)
    val total = poll.total
    val track = if (Theme.dark) 0x14FFFFFF else 0x0F000000
    optionRows.forEachIndexed { index, rowBox ->
      val row = RectF(rowBox).apply { offset(x, top) }
      val option = optionTexts[index]
      val textHeight = maxOf(18 * d, option.height.toFloat())
      val count = poll.counts.getOrElse(index) { 0 }
      val share = if (total > 0) count.toDouble() / total else 0.0
      val chosen = poll.mine.contains(index); val picked = poll.draft.contains(index)
      val lineTop = row.top + 4 * d
      val lineHeight = maxOf(20 * d, textHeight)
      val cy = lineTop + lineHeight / 2
      if (poll.voted) {
        sharePaint.color = palette.text
        canvas.drawText("${(share * 100).roundToInt()}%", row.left, cy - (sharePaint.ascent() + sharePaint.descent()) / 2, sharePaint)
      } else {
        val ink = if (picked) palette.accent else palette.muted
        line.color = ink; line.strokeWidth = 1.5f * d; fill.color = ink
        val cx = row.left + 10 * d
        if (poll.multiple) {
          if (picked) {
            canvas.drawRoundRect(cx - 8 * d, cy - 8 * d, cx + 8 * d, cy + 8 * d, 3 * d, 3 * d, fill)
            ChatIcons.draw(canvas, "check", cx, cy, 13 * d, palette.onAccent)
          } else canvas.drawRoundRect(cx - 7.5f * d, cy - 7.5f * d, cx + 7.5f * d, cy + 7.5f * d, 3 * d, 3 * d, line)
        } else canvas.drawCircle(cx, cy, 7.5f * d, line)
      }
      val textLeft = row.left + (if (poll.voted) 46 else 28) * d
      optionPaint.color = palette.text
      text(canvas, option, textLeft, lineTop + (lineHeight - option.height) / 2)
      if (chosen) {
        fill.color = palette.accent
        val cx = row.right - 9 * d
        canvas.drawCircle(cx, cy, 7.5f * d, fill)
        ChatIcons.draw(canvas, "check", cx, cy, 11 * d, palette.onAccent)
      }
      if (poll.voted) {
        val barTop = lineTop + lineHeight + 4 * d
        val barWidth = row.width() - 46 * d
        fill.color = track
        canvas.drawRoundRect(row.left + 46 * d, barTop, row.left + 46 * d + barWidth, barTop + 4 * d, 2 * d, 2 * d, fill)
        fill.color = if (chosen) palette.accent else palette.subtle
        canvas.drawRoundRect(row.left + 46 * d, barTop, row.left + 46 * d + barWidth * maxOf(0.02, share).toFloat(), barTop + 4 * d, 2 * d, 2 * d, fill)
      }
    }
    voteRow?.let { box ->
      val ready = poll.draft.isNotEmpty() && !poll.disabled
      votePaint.color = Theme.alpha(palette.accent, if (ready) 1f else 0.4f)
      canvas.drawText("Голосовать", x + box.centerX(), top + box.top + 8 * d - votePaint.ascent(), votePaint)
    }
    val footTop = top + footerY
    notePaint.color = palette.muted
    val count = if (poll.voters > 0) "${poll.voters} ${MsgPoll.votes(poll.voters)}" else "Пока нет голосов"
    canvas.drawText(TextUtils.ellipsize(count, notePaint, width * 0.6f, TextUtils.TruncateAt.END).toString(), x, footTop + 1 * d - notePaint.ascent(), notePaint)
    if (retract != null) {
      retractPaint.color = palette.accent
      val words = "Отменить голос"
      canvas.drawText(words, x + width - retractPaint.measureText(words), footTop + 8 * d - (retractPaint.ascent() + retractPaint.descent()) / 2, retractPaint)
    }
  }
}
