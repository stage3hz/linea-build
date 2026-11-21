package com.linea.messenger.ai

/** The release build's side of the AI samples (see src/debug): there are none, and no launch arguments. */
object AIDemo {
  val mode: String? get() = null
  val status: AIStatus? get() = null
  val models: List<String> get() = emptyList()
  val turns: List<AITurn> get() = emptyList()
  val history: List<AIStoredConversation> get() = emptyList()
}
