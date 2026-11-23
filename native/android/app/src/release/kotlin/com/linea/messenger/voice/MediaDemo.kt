package com.linea.messenger.voice

import android.content.Intent

/** The release build's side of the voice and video samples (see src/debug): no sample rows, no launch arguments,
 *  and no microphone in a chat without an account. */
object MediaDemo {
  const val sample = false

  @Suppress("UNUSED_PARAMETER")
  fun rows(intent: Intent?): List<Map<String, Any?>> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun state(intent: Intent?): MsgMediaState? = null

  @Suppress("UNUSED_PARAMETER")
  fun recording(intent: Intent?): Boolean = false

  @Suppress("UNUSED_PARAMETER")
  fun note(intent: Intent?): Boolean = false
}
