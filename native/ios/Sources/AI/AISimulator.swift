#if targetEnvironment(simulator)
import Foundation

/// A made-up conversation for looking at the «AI» section in the simulator without a server (`-aidemo 1`).
/// Compiled for the simulator only.
enum AIDemo {
    static let status = AIStatus(configured: true, model: "auto", provider: "freellmapi", platina: true, capabilities: [
        "text": AICapability(enabled: true, reason: nil), "code": AICapability(enabled: true, reason: nil), "image": AICapability(enabled: true, reason: nil),
        "video": AICapability(enabled: false, reason: nil), "speech": AICapability(enabled: true, reason: nil), "transcribe": AICapability(enabled: true, reason: nil),
        "models": AICapability(enabled: true, reason: nil),
    ])
    static let models = ["meta/llama-3.3-70b", "qwen/qwen3-coder", "mistral/mistral-small"]

    static var turns: [AITurn] {
        var first = AITurn(id: 1, question: "Чем отличается let от var в Swift?", status: "complete")
        first.answer = AIReply(text: "let объявляет константу: значение задаётся один раз. var — переменную, её можно менять. По умолчанию бери let и переходи на var, только когда значение действительно меняется.", model: "meta/llama-3.3-70b", provider: "freellmapi", routedVia: "groq")
        first.model = "auto:smart"
        first.ms = 3200
        var second = AITurn(id: 2, question: "Покажи пример с массивом", status: "complete")
        second.answer = AIReply(text: "Вот короткий пример:\n\n```swift\nlet names = [\"Алиса\", \"Лев\"]\nvar count = 0\nfor name in names {\n    count += name.count\n}\nprint(count)\n```\n\nМассив names менять нельзя, а счётчик count — можно.", model: "qwen/qwen3-coder", provider: "freellmapi", routedVia: nil)
        second.model = "auto:smart"
        second.ms = 5400
        var third = AITurn(id: 3, question: "А если добавить элемент в names?", status: "failed")
        third.error = "AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз."
        return [first, second, third]
    }

    static var history: [AIStoredConversation] {
        let now = AIModel.nowISO()
        return [
            AIStoredConversation(id: "demo-0000-0001", title: "Чем отличается let от var в Swift?", updatedAt: now, consent: true, turns: turns),
            AIStoredConversation(id: "demo-0000-0002", title: "Рецепт сырников без муки", updatedAt: now, consent: true, turns: [turns[0]]),
        ]
    }
}
#endif
