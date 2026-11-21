package com.linea.messenger.linkpreview

import android.content.Intent
import com.linea.messenger.chatactions.ChatHistory

/** The release build's side of the link cards' samples (see src/debug): no sample rows, no launch arguments. */
object LinkDemo {
  @Suppress("UNUSED_PARAMETER")
  fun rows(intent: Intent?): List<Map<String, Any?>> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun composerCard(intent: Intent?): Map<String, Any?>? = null

  @Suppress("UNUSED_PARAMETER")
  fun sendSample(intent: Intent?, history: ChatHistory) {}
}
