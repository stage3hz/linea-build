package com.linea.messenger.ai

/** A made-up conversation for looking at the «AI» section on the emulator without a server (`--es aidemo 1`).
 *  This file is in the debug source set: a release build is compiled with the empty `AIDemo` of src/release
 *  instead and contains none of this. */
object AIDemo {
  /** What the launch arguments asked for: `1`, `history`, or null (see music/MusicDemo.kt, `AIMusicSimulator`). */
  var mode: String? = null

  val status: AIStatus? = AIStatus(configured = true, model = "auto", provider = "freellmapi", platina = true, capabilities = mapOf(
    "text" to AICapability(true), "code" to AICapability(true), "image" to AICapability(true), "video" to AICapability(false),
    "speech" to AICapability(true), "transcribe" to AICapability(true), "models" to AICapability(true),
  ))
  val models = listOf("meta/llama-3.3-70b", "qwen/qwen3-coder", "mistral/mistral-small")

  val turns: List<AITurn>
    get() = listOf(
      AITurn(id = 1, question = "Чем отличается val от var в Kotlin?", status = "complete", model = "auto:smart", ms = 3200.0,
        answer = AIReply("val объявляет значение, которое задаётся один раз. var — переменную, её можно менять. По умолчанию бери val и переходи на var, только когда значение действительно меняется.", "meta/llama-3.3-70b", "freellmapi", "groq")),
      AITurn(id = 2, question = "Покажи пример со списком", status = "complete", model = "auto:smart", ms = 5400.0,
        answer = AIReply("Вот короткий пример:\n\n```kotlin\nval names = listOf(\"Алиса\", \"Лев\")\nvar count = 0\nfor (name in names) {\n    count += name.length\n}\nprintln(count)\n```\n\nСписок names менять нельзя, а счётчик count — можно.", "qwen/qwen3-coder", "freellmapi")),
      AITurn(id = 3, question = "А если добавить элемент в names?", status = "failed", error = "AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз."),
    )

  val history: List<AIStoredConversation>
    get() {
      val now = AIModel.nowISO()
      return listOf(
        AIStoredConversation("demo-0000-0001", "Чем отличается val от var в Kotlin?", now, true, turns),
        AIStoredConversation("demo-0000-0002", "Рецепт сырников без муки", now, true, listOf(turns[0])),
      )
    }
}
