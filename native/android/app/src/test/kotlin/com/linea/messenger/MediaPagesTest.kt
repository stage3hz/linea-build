package com.linea.messenger

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import com.linea.messenger.chat.MsgRowView
import com.linea.messenger.voice.ChatMedia
import com.linea.messenger.voice.MsgMediaBoxes
import com.linea.messenger.voice.Permits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlertDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** The chat with voice messages, videos and round videos, built and drawn on the JVM as `PagesTest` does: the
 *  launch arguments of the emulator check show what they should, with the words of the iPhone app. Each page is
 *  saved as a picture in build/pages/. Not a phone: nothing is recorded or played here. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaPagesTest {
  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun launch(name: String, intent: Intent, wait: Long = 1000): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    snap(name, activity.window.decorView)
    return activity
  }

  private fun idle(activity: MainActivity, wait: Long = 600) = shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)

  private fun find(view: View, className: String): View? {
    if (view.javaClass.simpleName == className) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), className)?.let { return it }
    return null
  }

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  /** What a screen reader would name: the views with a description. */
  private fun named(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    view.contentDescription?.let { into.add(it.toString()) }
    if (view is ViewGroup) for (index in 0 until view.childCount) named(view.getChildAt(index), into)
    return into
  }

  private fun described(view: View, start: String): View? {
    if (view.visibility != View.VISIBLE) return null
    if (view.contentDescription?.toString()?.startsWith(start) == true) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) described(view.getChildAt(index), start)?.let { return it }
    return null
  }

  private fun rows(view: View, into: MutableList<MsgRowView> = ArrayList()): List<MsgRowView> {
    if (view is MsgRowView) into.add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) rows(view.getChildAt(index), into)
    return into
  }

  private fun field(view: View): EditText? {
    if (view is EditText) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) field(view.getChildAt(index))?.let { return it }
    return null
  }

  private fun demo() = Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("chat", true)
  private val voiceWords = "Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео"
  private val videoWords = "Видеосообщение: удерживай для записи. Нажми — переключить на голосовое"

  @Test fun theSampleVoiceMessages() {
    val activity = launch("40-voice", demo().putExtra("voicedemo", "1"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val names = named(chat)
    assertTrue(names.toString(), names.containsAll(listOf("Голосовое сообщение, 0:23. 09:42", "Голосовое сообщение, 1:05. 09:43")))
    // The first one is shown as it looks while it plays, at one and a half times the speed; only its row knows.
    val d = chat.resources.displayMetrics.density
    val playing = rows(chat).single { it.rowKey == "sample-voice-1" }
    assertEquals(listOf(true, "0:07 / 0:23", "1,5×"), playing.mediaState!!.let { listOf(it.playing, it.time, it.rate) })
    assertNull(rows(chat).single { it.rowKey == "sample-voice-2" }.mediaState)
    // Its parts answer to touches: the button, the place on the waveform, the speed.
    assertEquals(Pair("play", 0f), playing.mediaAt(38f * d, 34f * d))
    val wave = playing.mediaAt(72f * d + 90f * d, 24f * d)!!
    assertEquals("wave", wave.first)
    assertEquals(0.5f, wave.second, 0.02f)
    assertEquals("rate", playing.mediaAt(72f * d + 170f * d, 49f * d)?.first)
    assertNull(playing.mediaAt(300f * d, 34f * d))
    assertNull(playing.mediaThumb())
    // Nothing to send: the microphone stands where the send button does. A tap switches it to the round video
    // and back, and says so in the field for a moment.
    val button = described(chat, "Голосовое:")!!
    assertEquals(voiceWords, button.contentDescription.toString())
    assertFalse(names.contains("Отправить"))
    val field = field(chat)!!
    button.performClick(); idle(activity, 100)
    assertEquals(listOf(videoWords, "Видео — удерживайте. Звук — нажмите."), listOf(button.contentDescription.toString(), field.hint.toString()))
    snap("40b-voice-video-mode", activity.window.decorView)
    idle(activity, 2500)
    assertEquals("Сообщение", field.hint.toString())
    button.performClick(); idle(activity, 100)
    assertEquals(listOf(voiceWords, "Звук — удерживайте. Видео — нажмите."), listOf(button.contentDescription.toString(), field.hint.toString()))
    // With words in the field the send button is back.
    field.setText("Привет"); idle(activity)
    assertTrue(named(chat).contains("Отправить"))
    assertNull(described(chat, "Голосовое:"))
    field.setText(""); idle(activity)
    assertNotNull(described(chat, "Голосовое:"))
    assertFalse(named(chat).contains("Отправить"))
    // Media: the paperclip opens its own panel — the gallery, the files, a poll, sound (attachments/AttachmentPanel.kt).
    described(chat, "Вложения:")!!.performClick(); idle(activity)
    val sheet = org.robolectric.shadows.ShadowDialog.getLatestDialog()
    assertTrue(sheet is com.linea.messenger.attachments.AttachmentPanel)
    assertTrue(named(sheet.window!!.decorView).containsAll(listOf("Галерея", "Файл", "Опрос", "Аудио", "Закрыть выбор вложений")))
    sheet.dismiss()
  }

  @Test fun theStripOfATakeBeingRecorded() {
    val activity = launch("41-voice-recording", demo().putExtra("voicedemo", "recording"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val words = texts(chat)
    assertTrue(words.toString(), words.containsAll(listOf("0:04,63", "‹ Влево — отмена", "Вверх — без рук")))
    // While the finger holds there is no «Отмена» and no pause: they come with the lock.
    assertFalse(words.contains("Отмена"))
    assertNull(described(chat, "Пауза"))
    assertFalse(named(chat).contains("Отправить"))
    // Without the argument nothing of it is there.
    val plain = launch("41-voice-none", demo())
    val quiet = texts(find(plain.window.decorView, "ChatScreen")!!)
    assertFalse(quiet.toString(), quiet.contains("0:04,63") || quiet.contains("‹ Влево — отмена") || quiet.contains("Вверх — без рук"))
    assertFalse(named(plain.window.decorView).any { it.startsWith("Голосовое сообщение") || it.startsWith("Видео") })
  }

  @Test fun theSampleVideoAndRoundVideo() {
    val activity = launch("42-video", demo().putExtra("videodemo", "1"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val names = named(chat)
    assertTrue(names.toString(), names.containsAll(listOf("Видео. 09:44", "Видеосообщение. 09:45")))
    val d = chat.resources.displayMetrics.density
    // A video keeps its shape (16:9 here); a round video is a circle 212 wide. A touch on either is a touch on its picture.
    val video = rows(chat).single { it.rowKey == "sample-video-1" }.mediaThumb()!!
    assertEquals(220f * d, video.width(), 1f)
    assertEquals(220f * d * 9 / 16, video.height(), 1f)
    val note = rows(chat).single { it.rowKey == "sample-video-2" }
    val circle = note.mediaThumb()!!
    assertEquals(listOf(212f * d, 212f * d), listOf(circle.width(), circle.height()))
    assertEquals(Pair("thumb", 0f), note.mediaAt(circle.centerX(), circle.centerY()))
    assertNull(note.mediaAt(circle.left - 4f * d, circle.centerY()))
  }

  @Test fun thePartsOfAMediaRow() {
    val boxes = MsgMediaBoxes()
    assertNull(boxes.part(10f, 10f, 1f))
    boxes.play.set(0f, 3f, 44f, 47f)
    boxes.wave.set(56f, 0f, 256f, 30f)
    boxes.rate.set(220f, 31f, 256f, 48f)
    assertEquals(Pair("play", 0f), boxes.part(22f, 25f, 1f))
    assertEquals(Pair("play", 0f), boxes.part(49f, 25f, 1f))
    assertEquals(Pair("wave", 0f), boxes.part(56f, 15f, 1f))
    assertEquals(Pair("wave", 1f), boxes.part(256f, -7f, 1f))
    assertEquals(Pair("wave", 0.25f), boxes.part(106f, 37f, 1f))
    // The speed chip is small: a touch near it is a touch on it, before the waveform.
    assertEquals(Pair("rate", 0f), boxes.part(230f, 36f, 1f))
    assertEquals(Pair("rate", 0f), boxes.part(262f, 55f, 1f))
    assertNull(boxes.part(300f, 15f, 1f))
    boxes.clear()
    boxes.thumb.set(10f, 10f, 110f, 110f)
    assertEquals(Pair("thumb", 0f), boxes.part(60f, 60f, 1f))
    assertNull(boxes.part(111f, 60f, 1f))
  }

  @Test fun thePickerOfVideosAndThePermissions() {
    // The system's photo picker showing videos only, at most five: no permission to the gallery.
    val videos = ChatMedia.videoPicker()
    assertEquals(listOf("android.provider.action.PICK_IMAGES", "video/*", 5), listOf(videos.action, videos.type, videos.getIntExtra("android.provider.extra.PICK_IMAGES_MAX", 0)))

    // Nothing is asked at the start; the microphone and the camera are asked at the moment of use, and the
    // system's answer comes back to whoever asked.
    val activity = launch("43-permissions", demo())
    val shadow = shadowOf(activity)
    assertNull(shadow.lastRequestedPermission)
    assertFalse(Permits.has(activity, Manifest.permission.RECORD_AUDIO))
    var answer: Boolean? = null
    Permits.ask(activity, listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) { answer = it }
    val asked = shadow.lastRequestedPermission
    assertEquals(listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO), asked.requestedPermissions.toList())
    assertNull(answer)
    activity.onRequestPermissionsResult(asked.requestCode, asked.requestedPermissions, intArrayOf(PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_DENIED))
    assertEquals(false, answer)
    // An answer nobody waits for is not this feature's.
    assertFalse(Permits.result(asked.requestCode, intArrayOf(PackageManager.PERMISSION_GRANTED)))
    // What is already given is not asked again.
    shadowOf(activity.application).grantPermissions(Manifest.permission.RECORD_AUDIO)
    var again: Boolean? = null
    Permits.ask(activity, listOf(Manifest.permission.RECORD_AUDIO)) { again = it }
    assertEquals(true, again)
    assertEquals(asked.requestCode, shadow.lastRequestedPermission.requestCode)
  }
}
