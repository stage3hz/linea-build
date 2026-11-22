package com.linea.messenger

import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.design.GlassHeaderView
import com.linea.messenger.design.GlassRoundButton
import com.linea.messenger.design.GlassSearchField
import com.linea.messenger.music.MusicInk
import com.linea.messenger.settings.SettingsLook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.TimeUnit

/** The glass parts of the reference's pages (design/GlassKit.kt) and where they are used: the header pill with its
 *  subtitle and round tools, the glass search, the switch colours, the top of «Музыка», the sign-in card and pill. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassKitTest {
  private fun all(view: View): List<View> = listOf(view) + (if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList())
  private fun shown(view: View): List<View> = if (view.visibility != View.VISIBLE) emptyList() else listOf(view) + (if (view is ViewGroup) (0 until view.childCount).flatMap { shown(view.getChildAt(it)) } else emptyList())
  private fun idle(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(ms, TimeUnit.MILLISECONDS)

  @Test fun theSwitchIsGreenWhenTheAccentIsPaleAndTheAccentOtherwise() {
    // ThemeSwitch (components.tsx): every channel above 190 is pale.
    assertEquals(0xFF34C77B.toInt(), SettingsLook.switchOn(0xFFE5E5E6.toInt()))
    assertEquals(0xFF34C77B.toInt(), SettingsLook.switchOn(0xFFFFFFFF.toInt()))
    assertEquals(0xFF5E7BFF.toInt(), SettingsLook.switchOn(0xFF5E7BFF.toInt()))
    assertEquals(0xFFB0F0F0.toInt(), SettingsLook.switchOn(0xFFB0F0F0.toInt()))
  }

  @Test fun theTopOfMusicIsMostOfTheUpperHalfOnTheMainTabOnly() {
    assertEquals(400f, MusicInk.headHeight(catalog = true, searching = false, screenHeight = 800f), 0.01f)
    assertEquals(430f, MusicInk.headHeight(catalog = true, searching = false, screenHeight = 1000f), 0.01f)
    assertEquals(132f, MusicInk.headHeight(catalog = true, searching = true, screenHeight = 800f), 0.01f)
    assertEquals(132f, MusicInk.headHeight(catalog = false, searching = false, screenHeight = 800f), 0.01f)
  }

  @Test fun theHeaderPillHoldsBackTheNameItsLineAndTheTools() {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true)).setup().get()
    var backed = 0
    val header = GlassHeaderView(activity, "Каналы", "Комнаты, серверы и каналы", titleSize = 26f, lineHeight = 32f, padding = 10f, minHeight = 64f, back = { backed += 1 })
    val tool = header.addTool("link", "Вступить по ссылке") {}
    header.addTool("plus", "Создать", filled = true) {}
    val width = 380 * 3
    header.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    header.layout(0, 0, width, header.measuredHeight)
    val d = activity.resources.displayMetrics.density
    assertTrue(header.measuredHeight >= Math.round(64 * d))
    val back = header.backButton!!
    // Left to right: back, the words, the tools; everything inside the pill.
    assertTrue(back.right <= header.titleLabel.left)
    assertTrue(header.titleLabel.right <= tool.left)
    assertTrue(header.subtitleLabel.top >= header.titleLabel.bottom)
    assertEquals("Комнаты, серверы и каналы", header.subtitleLabel.text.toString())
    assertEquals(Math.round(42 * d), (all(header).last() as GlassRoundButton).width)
    back.performClick()
    assertEquals(1, backed)
  }

  @Test fun aSettingsPageHasTheGlassHeaderAndTheRootHasNone() {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("settings", "appearance")).setup().get()
    idle(3000)
    val headers = shown(activity.window.decorView).filterIsInstance<GlassHeaderView>()
    assertTrue(headers.any { it.titleLabel.text.toString() == "Оформление" && it.backButton != null })
    // The root of Settings: no «Настройки» title anywhere.
    val root = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("tab", "profile")).setup().get()
    idle(1500)
    val words = shown(root.window.decorView).filterIsInstance<TextView>().map { it.text.toString() }
    assertTrue(words.toString(), "Мой профиль" in words && "Настройки" !in words && "Публикации и истории" !in words)
  }

  @Test fun peopleAndChannelsHaveTheirHeaderPills() {
    val people = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("tab", "people")).setup().get()
    idle(1500)
    val pill = shown(people.window.decorView).filterIsInstance<GlassHeaderView>().firstOrNull { it.titleLabel.text.toString() == "Люди" }
    assertNotNull(pill)
    assertEquals("Друзья, заявки и поиск по @имени", pill!!.subtitleLabel.text.toString())
    assertTrue(shown(people.window.decorView).any { it is GlassSearchField })

    val channels = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("tab", "channels")).setup().get()
    idle(1500)
    val views = shown(channels.window.decorView)
    val header = views.filterIsInstance<GlassHeaderView>().firstOrNull { it.titleLabel.text.toString() == "Каналы" }
    assertNotNull(header)
    assertEquals("Комнаты, серверы и каналы", header!!.subtitleLabel.text.toString())
    val tools = all(header).filterIsInstance<GlassRoundButton>().map { it.contentDescription.toString() }
    assertEquals(listOf("Вступить по ссылке", "Создать"), tools)
  }

  @Test fun theSignInStepsAreOnACardUnderTheThemePill() {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("auth", true)).setup().get()
    idle(800)
    val views = shown(activity.window.decorView)
    val pill = views.firstOrNull { it.javaClass.simpleName == "AuthThemePill" }
    assertNotNull(pill)
    assertTrue(pill!!.contentDescription.toString().startsWith("Оформление: "))
    val proceed = views.filterIsInstance<TextView>().first { it.text.toString() == "Войти" }
    // «Войти» (the switch) is on the card: a parent of it draws glass.
    var above = proceed.parent as? View
    var onGlass = false
    while (above != null) { if (above.background is com.linea.messenger.design.GlassDrawable) onGlass = true; above = above.parent as? View }
    assertTrue(onGlass)
  }
}
