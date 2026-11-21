package com.linea.messenger.chatlook

import com.linea.messenger.chat.ChatScreen

/** The release build's side of the look's demo (see src/debug): no launch arguments, no sample person. */
object LookDemo {
  val chatlook: String? get() = null
  val line: String? get() = null
  val composer: String? get() = null

  @Suppress("UNUSED_PARAMETER")
  fun peer(name: String): Map<String, Any?> = emptyMap()

  @Suppress("UNUSED_PARAMETER")
  fun run(screen: ChatScreen) {}
}
