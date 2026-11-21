package com.linea.messenger.core

import com.linea.core.json.JsonNumber
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonString

/** The shared core (Rust, native/core), as Kotlin sees it. The library is libinvizent_core.so, built by
 *  native/android/build-core.sh; the functions on its side are in native/core/src/jni.rs. */
object Core {
  /** False when the library is not in the app (a build made without build-core.sh): nothing of the core works. */
  val loaded: Boolean = try { System.loadLibrary("invizent_core"); true } catch (_: UnsatisfiedLinkError) { false }

  /** The version of the core, e.g. `0.1.0`. Throws UnsatisfiedLinkError without the library; see `version`. */
  @JvmStatic external fun coreVersion(): String

  /** The safety code for a pair of devices.
   *  In: `{"own":{"userId","deviceId","identityKey","registrationId"},"other":{…}}`. Out: the code, or null. */
  @JvmStatic external fun safetyCode(pairJson: String): String?

  /** The version of the core, or `?` when the library is missing. */
  val version: String get() = if (loaded) try { coreVersion() } catch (_: UnsatisfiedLinkError) { "?" } else "?"

  data class Device(val userId: String, val deviceId: String, val identityKey: String, val registrationId: Int)

  /** The code two people compare for a pair of devices; null if the pair is not valid. */
  fun safetyCode(own: Device, other: Device): String? {
    if (!loaded) return null
    fun json(device: Device) = JsonObject(linkedMapOf(
      "userId" to JsonString(device.userId), "deviceId" to JsonString(device.deviceId),
      "identityKey" to JsonString(device.identityKey), "registrationId" to JsonNumber(device.registrationId),
    ))
    return safetyCode(JsonObject(linkedMapOf("own" to json(own), "other" to json(other))).stringify())
  }
}
