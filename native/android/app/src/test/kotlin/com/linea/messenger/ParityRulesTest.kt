package com.linea.messenger

import com.linea.messenger.ai.AIAttach
import com.linea.messenger.channels.ChannelOutboxDisk
import com.linea.messenger.effects.Motion
import com.linea.messenger.language.Language
import com.linea.messenger.links.AppBadge
import com.linea.messenger.music.EqualizerSettings
import com.linea.messenger.music.MusicEqualizer
import com.linea.messenger.screenshare.ScreenQuality
import com.linea.messenger.screenshare.ScreenShareModel
import com.linea.messenger.security.LockRecord
import com.linea.messenger.security.LockRules
import com.linea.messenger.security.LockSettings
import com.linea.messenger.effects.MusicAmbientView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The pure rules of the parity wave (effects, lock, language, links, music, channels, AI, screen sharing): the same
 *  numbers and words as the reference and the iOS app. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ParityRulesTest {
  @Test fun theMotionPolicyIsTheReferencesOwn() {
    val calm = Motion.Power(level = 0.8, charging = false)
    assertTrue(Motion.motionAllowed("auto", calm, 0.25))
    assertFalse(Motion.motionAllowed("auto", calm.copy(level = 0.2), 0.25))
    assertTrue(Motion.motionAllowed("auto", calm.copy(level = 0.2, charging = true), 0.25))
    assertFalse(Motion.motionAllowed("auto", calm.copy(reduceMotion = true), 0.25))
    assertTrue(Motion.motionAllowed("on", calm.copy(lowPower = true), 0.25))
    assertFalse(Motion.motionAllowed("off", calm, 0.25))
    assertTrue(Motion.powerSaving(calm, 1.0))
    assertEquals("Выключены: заряд 20% — не больше 25%.", Motion.motionReason("auto", calm.copy(level = 0.2), 0.25))
    assertEquals("Включены. По заряду не выключаются, только в режиме энергосбережения.", Motion.motionReason("auto", calm, 0.0))
  }

  @Test fun aCodeIsHashedAndCheckedAsTheReferenceDoes() {
    // RFC 7914 §11 vector of PBKDF2-HMAC-SHA256 (P = "passwd", S = "salt", c = 1, dkLen = 64), the first 32 bytes.
    assertEquals("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc", LockRules.hex(LockRules.derive("passwd", "salt".toByteArray(), 1, 32)))
    val record = LockRules.makeRecord("1234")
    assertEquals("digits", record.kind)
    assertEquals(8000, record.iterations)
    assertTrue(LockRules.verify("1234", record))
    assertFalse(LockRules.verify("1235", record))
    assertEquals("password", LockRules.codeKind("12345"))
    assertEquals("Введи четыре цифры.", LockRules.codeProblem("12a4", "digits"))
    assertEquals(0.0, LockRules.retryDelayMs(4), 0.0)
    assertEquals(10_000.0, LockRules.retryDelayMs(5), 0.0)
    assertEquals(3_600_000.0, LockRules.retryDelayMs(40), 0.0)
    assertEquals("Попробуй через 10 с", LockRules.retryHint(9_500.0))
    assertEquals("Попробуй через 2 мин", LockRules.retryHint(61_000.0))
  }

  @Test fun theLockRecordIsTheReferencesJson() {
    val settings = LockSettings(LockRecord("digits", "00".repeat(16), "ab".repeat(32), 8000), biometrics = true, autolock = "5m", failures = 2, backgroundAt = 1000.0)
    val back = LockSettings.parse(settings.text())
    assertEquals(settings.record, back.record)
    assertTrue(back.biometrics)
    assertEquals("5m", back.autolock)
    assertEquals(2, back.failures)
    assertNull(LockSettings.parse("{\"record\":{\"kind\":\"digits\",\"salt\":\"00\",\"hash\":\"ab\",\"iterations\":8000}}").record)
    assertFalse(LockRules.shouldLockOnLaunch(LockSettings(), 0.0))
    assertTrue(LockRules.shouldLockOnLaunch(back.copy(autolock = "off"), 2000.0))
    assertFalse(LockRules.shouldLockOnReturn(back, wasBackground = true, now = 1000.0 + 60_000))
    assertTrue(LockRules.shouldLockOnReturn(back, wasBackground = true, now = 1000.0 + 300_000))
    // Android: no cover in the app switcher; «Сразу» locks on leaving.
    val now = LockRules.onLeave(back.copy(autolock = "immediate"), locked = false, background = true)
    assertEquals("now", now.lock); assertFalse(now.cover); assertTrue(now.recordBackgroundAt)
  }

  @Test fun theLanguageIsLookedUpByTheRussianText() {
    Language.source = { "{\"Настройки\":\"Settings\",\"Тема\":\"Theme\"}" }
    Language.reload()
    assertEquals("Settings", Language.tr("Настройки", "en"))
    assertEquals(" Settings ", Language.tr(" Настройки ", "en"))
    assertEquals("THEME", Language.tr("ТЕМА", "en"))
    assertEquals("Мария", Language.tr("Мария", "en"))
    assertEquals("Настройки", Language.tr("Настройки", "ru"))
    Language.source = null
  }

  @Test fun theBadgeCountsWhatTheServerCounts() {
    assertEquals(9, AppBadge.total(true, 4, 3, 2))
    assertEquals(0, AppBadge.total(false, 4, 3, 2))
  }

  @Test fun theEqualizerKeepsTheReferencesRecord() {
    val profile = EqualizerSettings.parse("{\"headphones\":{\"mode\":\"custom\",\"low\":4.3,\"mid\":-20,\"high\":true}}")
    assertEquals("custom", profile.mode); assertEquals(4.5, profile.low, 0.0); assertEquals(-12.0, profile.mid, 0.0); assertEquals(0.0, profile.high, 0.0)
    assertNull(EqualizerSettings.effective(EqualizerSettings.Profile()))
    assertEquals(6.0, MusicEqualizer.curve(doubleArrayOf(0.0, 6.0, 0.0), 1000.0), 0.001)
    assertEquals(0.5, MusicAmbientView.layerOpacity(0.5, 0, 5), 0.0001)
  }

  @Test fun theChannelOutboxReadsOnlyWhatIsWhole() {
    val items = ChannelOutboxDisk.parse("[{\"key\":\"k1\",\"communityId\":\"s\",\"channelId\":\"c\",\"text\":\"раз\",\"replyTo\":5},{\"key\":\"k1\",\"communityId\":\"s\",\"channelId\":\"c\",\"text\":\"дубль\"},{\"key\":\"k2\",\"communityId\":\"s\",\"channelId\":\"c\",\"text\":\"  \"}]")
    assertEquals(1, items.size)
    assertEquals(5L, items[0].replyTo)
    assertTrue(ChannelOutboxDisk.parse("не json").isEmpty())
  }

  @Test fun aPictureForTheModelIsKeptSmall() {
    assertEquals(1280 to 720, AIAttach.fitted(3840, 2160))
    assertEquals(800 to 600, AIAttach.fitted(800, 600))
  }

  @Test fun theScreenControlAndTheStereoSlotAreTheReferences() {
    assertEquals(true to ScreenQuality.P1080, ScreenShareModel.control("{\"type\":\"screen\",\"active\":true,\"quality\":\"1080p60\"}"))
    assertNull(ScreenShareModel.control("{\"type\":\"screen\",\"active\":true,\"quality\":\"4k\"}"))
    assertEquals("720p · 60 FPS", ScreenQuality.P720.label)
    val sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n"
    val made = ScreenShareModel.stereoScreenAudio(sdp)
    assertTrue(made.contains("a=fmtp:111 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=128000"))
    // The microphone's section stays mono.
    assertEquals(1, Regex("stereo=1;sprop").findAll(made).count())
    assertNotNull(made)
  }
}
