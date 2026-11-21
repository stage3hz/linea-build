package com.linea.messenger.design

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.text.SpannableString
import android.text.Spanned
import android.text.style.MetricAffectingSpan
import android.text.TextPaint
import android.widget.TextView
import com.linea.messenger.R

/** The app's typefaces, as the reference sets them (mobile/src/typography.tsx), mirroring
 *  native/ios/Sources/Design/Typography.swift:
 *   - every text is Montserrat (SIL OFL 1.1) with the usual weights 400…800;
 *   - screen titles and the big names of profiles are Unbounded ExtraBold (SIL OFL 1.1), letter spacing −0.2.
 *
 *  The faces are in res/font (copied from mobile/assets/fonts). The window's theme names Montserrat for every
 *  TextView and field (res/values/themes.xml); `install` also puts it in place of the system's default face, so
 *  the canvas-drawn texts and `Typeface.DEFAULT`/`DEFAULT_BOLD` give Montserrat too. Monospaced texts stay the
 *  system's, as the reference's MONO does.
 *
 *  For every screen (also on `Theme` in Theme.kt):
 *    Theme.weight(600)                 Montserrat SemiBold
 *    Theme.title / Theme.titled(view, 30f)   Unbounded ExtraBold (a title: «Чаты», «Люди», a profile's name)
 *    Theme.TypeSize.chatsTitle …       the sizes the reference uses */
object Fonts {
  /** Montserrat with its five weights (res/font/montserrat.xml); null until `install` or when it is missing. */
  var family: Typeface? = null
    private set
  /** Unbounded ExtraBold; null until `install` or when it is missing. */
  var titleFace: Typeface? = null
    private set
  private val faces = HashMap<Int, Typeface>()

  /** Loads the faces and makes the system's default face Montserrat. Called once, at launch (MainActivity). */
  fun install(context: Context) {
    if (family != null) return
    val resources = context.applicationContext?.resources ?: context.resources
    family = try { resources.getFont(R.font.montserrat) } catch (_: Throwable) { null }
    titleFace = try { resources.getFont(R.font.unbounded) } catch (_: Throwable) { null }
    val base = family ?: return
    // The public default faces read by code that names no face (a Paint, `Typeface.DEFAULT_BOLD`). Best effort:
    // where the system does not allow it, those few texts keep the system face.
    replace("DEFAULT", base)
    replace("SANS_SERIF", base)
    replace("DEFAULT_BOLD", Typeface.create(base, Typeface.BOLD))
    try {
      val setDefault = Typeface::class.java.getDeclaredMethod("setDefault", Typeface::class.java)
      setDefault.isAccessible = true
      setDefault.invoke(null, base)
    } catch (_: Throwable) { /* the native default stays the system's */ }
  }

  private fun replace(name: String, face: Typeface) {
    try {
      val field = Typeface::class.java.getDeclaredField(name)
      field.isAccessible = true
      field.set(null, face)
    } catch (_: Throwable) { /* kept as it was */ }
  }

  /** Montserrat at a weight: 800/900 ExtraBold, 700 Bold, 600 SemiBold, 500 Medium, the rest Regular. Without the
   *  faces, the system's font at that weight (before Android 9: regular or bold). */
  fun weight(weight: Int): Typeface {
    val wanted = when { weight >= 800 -> 800; weight >= 700 -> 700; weight >= 600 -> 600; weight >= 500 -> 500; else -> 400 }
    faces[wanted]?.let { return it }
    val base = family
    val made = when {
      base != null && Build.VERSION.SDK_INT >= 28 -> Typeface.create(base, wanted, false)
      base != null -> Typeface.create(base, if (wanted >= 600) Typeface.BOLD else Typeface.NORMAL)
      Build.VERSION.SDK_INT >= 28 -> Typeface.create(Typeface.DEFAULT, wanted, false)
      else -> Typeface.create(Typeface.DEFAULT, if (wanted >= 600) Typeface.BOLD else Typeface.NORMAL)
    }
    if (base != null) faces[wanted] = made
    return made
  }

  /** Unbounded ExtraBold, or the system's heaviest face without it. */
  val title: Typeface get() = titleFace ?: weight(800)
}

/** A span that sets its words in Unbounded ExtraBold (a title inside a longer text). */
class TitleSpan : MetricAffectingSpan() {
  override fun updateMeasureState(paint: TextPaint) { paint.typeface = Fonts.title }
  override fun updateDrawState(paint: TextPaint) { paint.typeface = Fonts.title }
}

/** Words set as a title (Unbounded ExtraBold) to put in a TextView beside other words. */
fun titleWords(text: String): CharSequence = SpannableString(text).apply { setSpan(TitleSpan(), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }

/** A TextView set as a title: Unbounded ExtraBold at `size` sp with the reference's −0.2 letter spacing. */
fun TextView.titled(size: Float): TextView = Titles.title(this, size)

/** The same as a plain call, for a file that sets one title without importing the extension. */
object Titles {
  fun title(view: TextView, size: Float): TextView = view.titledNow(size)
}

private fun TextView.titledNow(size: Float): TextView {
  typeface = Fonts.title
  textSize = size
  letterSpacing = Theme.titleKern / size
  return this
}
