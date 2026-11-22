package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Insets
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.EditText
import com.linea.messenger.auth.AuthScreen
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

/** The sign-in screen on the smallest phone (360×640 dp) with the keyboard up: nothing scrolls, and the step's title,
 *  the fields, the button stand above the keyboard (auth/AuthFit.kt). Pictures in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-port-320dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AuthKeyboardPagesTest {
  private lateinit var activity: MainActivity
  private lateinit var auth: AuthScreen

  private fun find(view: View, test: (View) -> Boolean): View? {
    if (test(view)) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), test)?.let { return it }
    return null
  }

  private fun idle(ms: Long) = shadowOf(activity.mainLooper).idleFor(ms, TimeUnit.MILLISECONDS)

  private fun open(mode: String) {
    val intent = Intent(Intent.ACTION_MAIN).putExtra("auth", true).putExtra("authmode", mode)
    activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    auth = find(activity.window.decorView) { it is AuthScreen } as AuthScreen
    idle(100)
  }

  /** The keyboard comes up: 24 dp of status bar, a keyboard of 290 dp with the navigation bar. */
  private fun keyboard(dp: Int) {
    val d = activity.resources.displayMetrics.density
    val insets = WindowInsets.Builder()
      .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, Math.round(24 * d), 0, 0))
      .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, Math.round(24 * d)))
      .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, Math.round(dp * d)))
      .build()
    auth.dispatchApplyWindowInsets(insets)
    auth.requestLayout()
    idle(600)
  }

  private fun bottomOf(view: View): Int {
    val place = IntArray(2)
    view.getLocationInWindow(place)
    return place[1] + view.height
  }

  private fun shot(name: String) {
    val page = activity.window.decorView
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun checkAboveTheKeyboard(keyboardDp: Int) {
    val d = activity.resources.displayMetrics.density
    val keyboardTop = auth.height - Math.round(keyboardDp * d)
    val fields = ArrayList<View>()
    fun collect(view: View) {
      if (view is EditText && view.visibility == View.VISIBLE && (view.parent as View).visibility != View.GONE) fields.add(view)
      if (view is ViewGroup) for (index in 0 until view.childCount) collect(view.getChildAt(index))
    }
    collect(auth)
    val shownFields = fields.filter { var v: View? = it; var on = true; while (v != null && v !== auth) { if (v.visibility != View.VISIBLE) on = false; v = v.parent as? View }; on }
    assertTrue("a field is on the step", shownFields.isNotEmpty())
    for (field in shownFields) assertTrue("field above the keyboard", bottomOf(field) <= keyboardTop)
    val button = find(auth) { it is com.linea.messenger.effects.ActionButton }!!
    assertTrue("the button above the keyboard: ${bottomOf(button)} ≤ $keyboardTop", bottomOf(button) <= keyboardTop)
    val heading = find(auth) { it is com.linea.messenger.effects.AppearingTextView }!!
    val place = IntArray(2)
    heading.getLocationInWindow(place)
    assertTrue("the title on the screen", place[1] >= 0 && bottomOf(heading) <= keyboardTop)
  }

  @Test fun theProfileStepFitsAboveTheKeyboard() {
    open("profile")
    keyboard(290)
    shot("60-keyboard-small-profile")
    checkAboveTheKeyboard(290)
  }

  @Test fun theRegisterStepFitsAboveTheKeyboard() {
    open("register")
    keyboard(290)
    shot("61-keyboard-small-register")
    checkAboveTheKeyboard(290)
  }

  @Test fun theRecoveryStepFitsAboveTheKeyboard() {
    open("recover")
    keyboard(290)
    shot("62-keyboard-small-recover")
    checkAboveTheKeyboard(290)
  }
}
