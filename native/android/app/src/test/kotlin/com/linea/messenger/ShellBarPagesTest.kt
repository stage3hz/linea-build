package com.linea.messenger

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.linea.messenger.shell.KeepsTabBar
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.TimeUnit

/** The bar of the sections over pushed pages, on the JVM: a page that keeps the bar has it at its bottom, where it
 *  stands in the sections; a page that does not keep it covers it; a touch on the bar over a pushed page goes back
 *  to the sections first. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ShellBarPagesTest {
  /** A pushed page that keeps the bar, and one that does not. */
  private class Kept(context: Context) : FrameLayout(context), KeepsTabBar
  private class Plain(context: Context) : FrameLayout(context)

  private lateinit var activity: MainActivity
  private lateinit var stack: Navigation
  private lateinit var root: RootScreen
  private lateinit var bar: View

  private fun launch() {
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true)).setup().get()
    idle()
    val page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    root = find(page) { it is RootScreen } as RootScreen
    bar = find(page) { it.javaClass.simpleName == "TabBarView" }!!
  }

  private fun idle(ms: Long = 500) = shadowOf(activity.mainLooper).idleFor(ms, TimeUnit.MILLISECONDS)

  private fun find(view: View, test: (View) -> Boolean): View? {
    if (test(view)) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), test)?.let { return it }
    return null
  }

  /** The view and everything it stands in are shown. */
  private fun shown(view: View): Boolean {
    var at: View? = view
    while (at != null) {
      if (at.visibility != View.VISIBLE) return false
      at = at.parent as? View
    }
    return true
  }

  /** The view's upper edge, from the top of the stack of pages. */
  private fun topInStack(view: View): Int {
    var y = 0
    var at: View? = view
    while (at != null && at !== stack) { y += at.top; at = at.parent as? View }
    return y
  }

  private fun push(page: View) { stack.push(page, animated = false); idle() }

  private fun tap(view: View, x: Float, y: Float) {
    val now = SystemClock.uptimeMillis()
    val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0)
    val up = MotionEvent.obtain(now, now + 20, MotionEvent.ACTION_UP, x, y, 0)
    view.dispatchTouchEvent(down)
    view.dispatchTouchEvent(up)
    down.recycle(); up.recycle()
  }

  @Test fun aPageThatKeepsTheBarHasItWhereTheSectionsDo() {
    launch()
    assertSame(root, bar.parent)
    val top = topInStack(bar); val left = bar.left; val wide = bar.width; val tall = bar.height
    assertTrue(wide > 0 && tall > 0)

    val page = Kept(activity)
    push(page)
    assertTrue(stack.barKept(page))
    assertTrue(bar.parent !== root)
    assertTrue(shown(bar))
    assertEquals(View.INVISIBLE, root.visibility)
    assertEquals(top, topInStack(bar))
    assertEquals(left, bar.left)
    assertEquals(wide, bar.width)
    assertEquals(tall, bar.height)
    // The room the page leaves: the bar, its gap to the screen's edge (10 without a navigation bar) and 9 above.
    val d = activity.resources.displayMetrics.density
    assertEquals(Math.round((10f + 62f + 9f) * d), stack.barRoom(page, 0))
    assertEquals(Math.round((24f + 10f + 62f + 9f) * d), stack.barRoom(page, Math.round(24f * d)))

    // A second page that keeps it: the bar stays over the stack.
    val next = Kept(activity)
    push(next)
    assertTrue(stack.barKept(next))
    assertTrue(bar.parent !== root && shown(bar))

    // Back to the sections: the bar is theirs again, in the same place.
    stack.pop(animated = false); stack.pop(animated = false); idle()
    assertEquals(1, stack.depth)
    assertSame(root, bar.parent)
    assertTrue(shown(bar))
    assertEquals(top, topInStack(bar))
    assertEquals(wide, bar.width)
  }

  @Test fun aPageThatDoesNotKeepTheBarCoversIt() {
    launch()
    val page = Plain(activity)
    push(page)
    assertFalse(stack.barKept(page))
    assertEquals(0, stack.barRoom(page, 0))
    assertSame(root, bar.parent)
    assertFalse(shown(bar))

    // A page that keeps the bar, over one that does not: no bar either (it stands only while every page keeps it).
    val over = Kept(activity)
    push(over)
    assertFalse(stack.barKept(over))
    assertSame(root, bar.parent)
    assertFalse(shown(bar))
  }

  @Test fun aPageThatDoesNotKeepTheBarTakesItFromThePageUnderIt() {
    launch()
    val under = Kept(activity)
    push(under)
    assertTrue(bar.parent !== root)
    push(Plain(activity))
    assertSame(root, bar.parent)
    assertFalse(shown(bar))
    // …and gives it back when it leaves.
    stack.pop(animated = false); idle()
    assertSame(under, stack.top)
    assertTrue(bar.parent !== root && shown(bar))
  }

  @Test fun aTouchOnTheBarOverAPushedPageGoesBackToTheSections() {
    launch()
    assertEquals("chats", root.open)
    push(Kept(activity))
    push(Kept(activity))
    assertEquals(3, stack.depth)
    // The second icon of the bar: «Настройки».
    tap(bar, bar.width * 0.75f, bar.height / 2f)
    idle()
    assertEquals(1, stack.depth)
    assertSame(root, stack.top)
    assertEquals(View.VISIBLE, root.visibility)
    assertEquals("profile", root.open)
    assertSame(root, bar.parent)
    assertTrue(shown(bar))
  }

  @Test fun aTouchOnTheChosenIconOverAPushedPageGoesBackToo() {
    launch()
    push(Kept(activity))
    // The first icon: «Чаты», the section that is open under the page.
    tap(bar, bar.width * 0.25f, bar.height / 2f)
    idle()
    assertEquals(1, stack.depth)
    assertEquals("chats", root.open)
    assertSame(root, bar.parent)
  }
}
