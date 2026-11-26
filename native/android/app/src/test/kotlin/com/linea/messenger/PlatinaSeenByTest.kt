package com.linea.messenger

import android.view.View
import android.view.ViewGroup
import com.linea.messenger.chats.ChatRowView
import com.linea.messenger.platina.PlatinaSamples
import com.linea.messenger.platina.PlatinaStudioView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** «Оформление профиля» → «Так тебя видят»: the studio shows the account's own row of the chat list (the real
 *  ChatRowView, made by the list's own Messenger.summary), with the chosen nameplate, frame and status, and the two
 *  ticks of a read «Привет!». */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlatinaSeenByTest {
  private val me = mapOf<String, Any?>("id" to "u-mira", "displayName" to "Мира", "username" to "mira", "avatarColor" to "#5E7BFF",
    "seal" to "platina", "nameplate" to "night", "avatarFrame" to "fx-orbit", "statusEmoji" to "💎", "statusEmojiPermanent" to true)

  @After fun clear() { PlatinaSamples.me = null }

  private fun rows(view: View): List<ChatRowView> = when (view) {
    is ChatRowView -> listOf(view)
    is ViewGroup -> (0 until view.childCount).flatMap { rows(view.getChildAt(it)) }
    else -> emptyList()
  }

  @Test fun theRowIsTheListsOwn() {
    val row = PlatinaStudioView.previewRow(me, "")
    assertNotNull(row); row!!
    assertEquals("Мира 💎", row.title)
    assertEquals("Привет!", row.preview)
    assertEquals(2, row.ticks)
    assertEquals("night", row.plate)
    assertEquals("fx-orbit", row.deco)
    assertEquals(4, row.nameLen)
    assertTrue(row.time.isNotEmpty())
    // Without Platina: the free look, the plain name.
    val free = PlatinaStudioView.previewRow(mapOf("id" to "u-lev", "displayName" to "Лев"), "")!!
    assertEquals("Лев", free.title); assertEquals("", free.plate); assertTrue(free.metal.isEmpty())
  }

  @Test fun theStudioShowsIt() {
    PlatinaSamples.me = { me }
    val studio = PlatinaStudioView(RuntimeEnvironment.getApplication(), null, compact = false)
    val found = rows(studio)
    assertEquals(1, found.size)
    assertTrue(found.single().contentDescription.toString(), found.single().contentDescription.toString().startsWith("Мира"))
    assertEquals("studio-preview", found.single().rowId)
    // Inside the profile editor (compact) only the decorations, no preview.
    assertTrue(rows(PlatinaStudioView(RuntimeEnvironment.getApplication(), null, compact = true)).isEmpty())
  }
}
