package com.linea.messenger.security

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import com.linea.messenger.net.Live
import com.linea.messenger.storage.Keystore
import org.json.JSONObject
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** «Код-пароль»: the pure rules — what a code looks like, how it is hashed and checked, when the app locks by itself
 *  and how long a wrong guess costs. (The previous app: `mobile/src/lock/model.ts`, every number and rule the same;
 *  iOS Security/LockModel.swift.) No views here. */
object LockRules {
  /** When the app locks after it was last in the foreground. `immediate` = at once on leaving («Сразу»). */
  val autolockModes = listOf("off", "immediate", "1m", "5m", "1h", "5h")
  val autolockLabels = mapOf("off" to "Выключена", "immediate" to "Сразу", "1m" to "Через 1 мин", "5m" to "Через 5 мин", "1h" to "Через 1 ч", "5h" to "Через 5 ч")

  /** Milliseconds in the background before the lock, null = never by itself. */
  fun autolockMs(mode: String): Double? = when (mode) {
    "immediate" -> 0.0
    "1m" -> 60_000.0
    "5m" -> 5 * 60_000.0
    "1h" -> 3_600_000.0
    "5h" -> 5 * 3_600_000.0
    else -> null
  }

  const val DIGITS_LENGTH = 4
  /** PBKDF2-HMAC-SHA256 rounds for a new code (old records keep their own count). */
  const val KDF_ITERATIONS = 8_000
  const val SALT_BYTES = 16
  const val HASH_BYTES = 32

  /** Only exactly four digits are a «4-значный код»; anything else is a password. */
  fun codeKind(code: String): String = if (code.length == 4 && code.all { it in '0'..'9' }) "digits" else "password"

  /** A code the person may set: four digits, or a password of 1–64 characters. */
  fun codeProblem(code: String, kind: String): String? {
    if (kind == "digits") return if (codeKind(code) == "digits") null else "Введи четыре цифры."
    if (code.isEmpty()) return "Пароль не может быть пустым."
    if (code.length > 64) return "Пароль слишком длинный."
    return null
  }

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { String.format("%02x", it.toInt() and 0xFF) }

  fun bytes(hex: String): ByteArray? {
    if (hex.length % 2 != 0 || !hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
    return ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
  }

  /** PBKDF2-HMAC-SHA256 of the code's UTF-8 (NFC) bytes (RFC 8018; the reference's @noble/hashes pbkdf2Async). */
  fun derive(code: String, salt: ByteArray, iterations: Int, length: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    val key = Normalizer.normalize(code, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8)
    // HMAC pads a short key with zeros: one zero byte is the same key as none (the key class refuses an empty one).
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
    val out = ByteArray(length)
    var block = 1; var at = 0
    while (at < length) {
      mac.update(salt)
      mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
      var u = mac.doFinal()
      val t = u.copyOf()
      for (round in 1 until iterations) {
        u = mac.doFinal(u)
        for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
      }
      val take = min(t.size, length - at)
      System.arraycopy(t, 0, out, at, take)
      at += take; block += 1
    }
    return out
  }

  /** A fresh salted hash of `code`. */
  fun makeRecord(code: String, random: SecureRandom = SecureRandom()): LockRecord {
    val salt = ByteArray(SALT_BYTES).also { random.nextBytes(it) }
    return LockRecord(codeKind(code), hex(salt), hex(derive(code, salt, KDF_ITERATIONS, HASH_BYTES)), KDF_ITERATIONS)
  }

  /** Same length and bytes, in time that does not depend on where they differ. */
  fun verify(code: String, record: LockRecord): Boolean {
    val expected = bytes(record.hash) ?: return false
    val salt = bytes(record.salt) ?: return false
    val actual = try { derive(code, salt, record.iterations, expected.size) } catch (_: Exception) { return false }
    if (actual.size != expected.size) return false
    var diff = 0
    for (index in actual.indices) diff = diff or (actual[index].toInt() xor expected[index].toInt())
    return diff == 0
  }

  const val RETRY_FREE_ATTEMPTS = 5
  const val RETRY_BASE_MS = 10_000.0
  const val RETRY_MAX_MS = 3_600_000.0

  /** After five wrong codes the next try waits 10 s, then 20, 40, 80… up to an hour. */
  fun retryDelayMs(failures: Int): Double {
    if (failures < RETRY_FREE_ATTEMPTS) return 0.0
    return min(RETRY_MAX_MS, RETRY_BASE_MS * 2.0.pow(min(30, failures - RETRY_FREE_ATTEMPTS).toDouble()))
  }

  /** Milliseconds still to wait since the last wrong code (0 = may try). */
  fun retryWaitMs(failures: Int, lastFailureAt: Double?, now: Double): Double {
    val last = lastFailureAt ?: return 0.0
    val elapsed = now - last
    // A clock that jumped back cannot shorten the wait past the full delay.
    if (elapsed < 0) return retryDelayMs(failures)
    return max(0.0, retryDelayMs(failures) - elapsed)
  }

  fun retryHint(waitMs: Double): String {
    val seconds = ceil(waitMs / 1000).toInt()
    if (seconds <= 0) return ""
    if (seconds < 60) return "Попробуй через $seconds с"
    if (seconds < 3600) return "Попробуй через ${ceil(seconds / 60.0).toInt()} мин"
    return "Попробуй через 1 ч"
  }

  /** On return to the foreground: lock when the time away reached the autolock delay (a clock that went backwards
   *  counts as a long absence). The first launch with a code is always locked. */
  fun shouldLock(settings: LockSettings, now: Double): Boolean {
    if (settings.record == null) return false
    val left = settings.backgroundAt ?: return true
    val limit = autolockMs(settings.autolock) ?: return false
    val away = now - left
    return away < 0 || away >= limit
  }

  /** A cold start with a code set: always locked when autolock is off, otherwise by the time away. */
  fun shouldLockOnLaunch(settings: LockSettings, now: Double): Boolean = settings.record != null && (settings.autolock == "off" || shouldLock(settings, now))

  /** Leaving the foreground: «Сразу» locks now. */
  fun locksOnBackground(settings: LockSettings): Boolean = settings.record != null && settings.autolock == "immediate"

  class LeaveAction(val recordBackgroundAt: Boolean = false, val lock: String = "no", val cover: Boolean = false)

  /** The app leaves the foreground (`onLeave` of the reference). On Android only «background» comes, and there is no
   *  cover: the cover of the app switcher is the iPhone's (`cover = ios && !locked`). */
  fun onLeave(settings: LockSettings, locked: Boolean, background: Boolean, ios: Boolean = false): LeaveAction {
    if (settings.record == null) return LeaveAction()
    val record = !locked && background
    val cover = ios && !locked
    if (locked || !locksOnBackground(settings)) return LeaveAction(record, "no", cover)
    return LeaveAction(record, if (background) "now" else if (ios) "soon" else "no", cover)
  }

  /** Back in the foreground: only a real stay in the background counts, and only when the time away reached the
   *  autolock delay. «Сразу» never locks on return — it locked on leaving. */
  fun shouldLockOnReturn(settings: LockSettings, wasBackground: Boolean, now: Double): Boolean =
    wasBackground && settings.autolock != "immediate" && shouldLock(settings, now)

  fun nowMs(): Double = System.currentTimeMillis().toDouble()
}

/** What is kept on the device. The code itself never is: only its salted PBKDF2 hash. */
data class LockRecord(val kind: String, val salt: String, val hash: String, val iterations: Int)

data class LockSettings(
  val record: LockRecord? = null,
  val biometrics: Boolean = false,
  val autolock: String = "1m",
  /** Wrong guesses in a row (reset by a right one). */
  val failures: Int = 0,
  /** When the app was last in the foreground with the lock open (ms); null = never — or locked when last seen. */
  val backgroundAt: Double? = null,
  /** When the last wrong code was typed (ms); null = none since the last right one. */
  val lastFailureAt: Double? = null,
) {
  /** The record as the previous app keeps it (the same JSON), so an update finds the code that was set. */
  fun text(): String? {
    val record = record ?: return null
    val value = JSONObject()
    value.put("record", JSONObject().put("kind", record.kind).put("salt", record.salt).put("hash", record.hash).put("iterations", record.iterations))
    value.put("biometrics", biometrics).put("autolock", autolock).put("failures", failures)
    value.put("backgroundAt", backgroundAt ?: JSONObject.NULL).put("lastFailureAt", lastFailureAt ?: JSONObject.NULL)
    return value.toString()
  }

  companion object {
    fun parse(raw: String?): LockSettings {
      if (raw.isNullOrEmpty()) return LockSettings()
      val value = try { JSONObject(raw) } catch (_: Exception) { return LockSettings() }
      var record: LockRecord? = null
      val r = value.optJSONObject("record")
      if (r != null) {
        val kind = r.opt("kind") as? String; val salt = r.opt("salt") as? String; val hash = r.opt("hash") as? String
        val iterations = (r.opt("iterations") as? Number)?.toDouble()
        if ((kind == "digits" || kind == "password") && salt != null && hash != null && salt.isNotEmpty() && LockRules.bytes(salt) != null && LockRules.bytes(hash) != null &&
          hash.length == LockRules.HASH_BYTES * 2 && iterations != null && iterations >= 1000) record = LockRecord(kind, salt, hash, iterations.toInt())
      }
      val mode = (value.opt("autolock") as? String)?.takeIf { it in LockRules.autolockModes } ?: "1m"
      val failures = (value.opt("failures") as? Number)?.toDouble()?.takeIf { it >= 0 }?.toInt() ?: 0
      return LockSettings(
        record = record,
        biometrics = record != null && value.opt("biometrics") == true,
        autolock = mode,
        failures = failures,
        backgroundAt = (value.opt("backgroundAt") as? Number)?.toDouble(),
        lastFailureAt = (value.opt("lastFailureAt") as? Number)?.toDouble(),
      )
    }
  }
}

/** Where the code-lock settings live and the one store the screens read them from (the previous app:
 *  `mobile/src/lock/storage.ts` — SecureStore, the entry `linea.passcode.v1`, which on Android is the very keystore-sealed
 *  preference storage/Keystore.kt reads, so an update keeps the code). */
object LockStore {
  const val NAME = "linea.passcode.v1"
  val changed = Live.Signal<Unit>()
  private var app: Context? = null
  private val main = Handler(Looper.getMainLooper())

  /** For the tests and the emulator check: where the record is read and written instead of the keystore. */
  internal var backend: Backend? = null
  interface Backend { fun read(): String?; fun write(text: String?) }

  var current = LockSettings()
    private set
  var loaded = false
    private set

  fun attach(context: Context) { app = context.applicationContext }

  /** Reads the saved settings. Throws when the keystore cannot be read: that is never taken for «no code set». */
  fun load() {
    val known = backend
    val raw = if (known != null) known.read() else app?.let { Keystore.get(it, NAME) }
    current = LockSettings.parse(raw)
    loaded = true
    changed.post(Unit)
  }

  /** Changes some of them and keeps them (without a code nothing is kept at all). */
  fun update(change: (LockSettings) -> LockSettings) {
    var next = change(current)
    if (next.record == null) next = next.copy(biometrics = false, failures = 0, lastFailureAt = null)
    current = next
    write(next.text())
    changed.post(Unit)
  }

  private fun write(text: String?) {
    backend?.let { return it.write(text) }
    val context = app ?: return
    try { if (text == null) Keystore.remove(context, NAME) else Keystore.set(context, NAME, text) } catch (_: Exception) { /* kept in memory for this run */ }
  }

  fun recordFailure() { val now = LockRules.nowMs(); update { it.copy(failures = it.failures + 1, lastFailureAt = now) } }

  /** A right code anywhere: the wait is over, the app counts as open from now. */
  fun recordSuccess() { val now = LockRules.nowMs(); update { it.copy(failures = 0, lastFailureAt = null, backgroundAt = now) } }

  /** Milliseconds before the next try is allowed (0 = may try). */
  val waitMs: Double get() = LockRules.retryWaitMs(current.failures, current.lastFailureAt, LockRules.nowMs())

  /** Turns the lock on with `code` (or replaces the code, keeping the other choices). */
  fun enable(code: String): Boolean {
    val record = try { LockRules.makeRecord(code) } catch (_: Exception) { return false }
    val now = LockRules.nowMs()
    update { it.copy(record = record, failures = 0, lastFailureAt = null, backgroundAt = now) }
    return true
  }

  fun disable() { update { it.copy(record = null, biometrics = false, failures = 0, lastFailureAt = null, backgroundAt = null) } }

  /** Checks a code off the main thread (the hash takes a moment) and answers on the main thread. */
  fun check(code: String, done: (Boolean) -> Unit) {
    val record = current.record ?: return done(false)
    Thread {
      val right = LockRules.verify(code, record)
      main.post { done(right) }
    }.apply { name = "lock-check"; isDaemon = true }.start()
  }
}

/** The fingerprint or the face (the reference's expo-local-authentication: the system's biometric prompt). The device's
 *  own screen lock is never accepted instead: the app has its own code. */
object LockBiometrics {
  /** What the switch and the pad key are called: «Отпечаток пальца» or «Биометрия»; null when nothing is enrolled. */
  fun label(context: Context): String? {
    if (Build.VERSION.SDK_INT < 29) return null
    val manager = context.getSystemService(BiometricManager::class.java) ?: return null
    @Suppress("DEPRECATION")
    val ready = try { if (Build.VERSION.SDK_INT >= 30) manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) else manager.canAuthenticate() } catch (_: Exception) { return null }
    if (ready != BiometricManager.BIOMETRIC_SUCCESS) return null
    val packages = context.packageManager
    val finger = packages.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
    val face = packages.hasSystemFeature(PackageManager.FEATURE_FACE)
    return if (finger && !face) "Отпечаток пальца" else "Биометрия"
  }

  /** True once the system confirmed the owner (answers on the main thread). */
  fun authenticate(activity: Activity, prompt: String = "Разблокировать Инвиз", done: (Boolean) -> Unit) {
    if (Build.VERSION.SDK_INT < 29) return done(false)
    try {
      val main = activity.mainExecutor
      val builder = BiometricPrompt.Builder(activity).setTitle(prompt).setNegativeButton("Отмена", main) { _, _ -> done(false) }
      if (Build.VERSION.SDK_INT >= 30) builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
      builder.build().authenticate(CancellationSignal(), main, object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = done(true)
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) = done(false)
      })
    } catch (_: Exception) { done(false) }
  }
}
