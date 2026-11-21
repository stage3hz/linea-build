package com.linea.messenger.chatactions

/** The release build's side of the actions' demo (see src/debug): no sample chat, no launch arguments. */
object ChatActionsDemo {
  const val present = false
  const val peer = ""
  const val draft = ""
  const val read = 0L
  val chatdemo: String? get() = null
  val chataction: String? get() = null
  val chatlist: String? get() = null
  val chatsearch: String? get() = null

  @Suppress("UNUSED_PARAMETER")
  fun client(index: Int): String = ""

  @Suppress("UNUSED_PARAMETER")
  fun seed(chatId: String, userId: String, extra: String): List<Map<String, Any?>> = emptyList()

  fun forwardTargets(): List<ForwardPicker.Target> = emptyList()
}
