import Foundation

// The AI section's rules and forms, ported from mobile/src/ai/conversation.ts, history.ts, intent.ts and
// client.ts. Lengths are counted the way the reference counts them (UTF-16 units), so both apps agree on
// what fits and read each other's stored history.

enum AILimits {
    static let message = 8000
    static let history = 32000
    static let count = 20
    static let answer = 16000
    static let historyMax = 60
    static let storedTurns = 40
}

/// Why something of the AI did not work: the words for the person.
struct AIFailure: Error {
    let words: String
    init(_ words: String) { self.words = words }
}

struct AIReply: Equatable {
    var text: String
    var model: String
    var provider: String
    var routedVia: String?

    var json: [String: Any] {
        var out: [String: Any] = ["text": text, "model": model, "provider": provider, "freeOnly": true]
        if let routedVia { out["routedVia"] = routedVia }
        return out
    }
}

struct AIMedia: Equatable {
    /// The cache file's name (the stored form) or a file URI of the cache.
    var uri: String
    var mimeType: String
}

struct AITurn: Equatable {
    var id: Int
    var question: String
    /// pending · complete · failed · cancelled
    var status: String
    var answer: AIReply?
    var error: String?
    /// The model chosen for this question (`options.model` of the reference), nil = «Авто».
    var model: String?
    var startedAt: Date?
    var ms: Double?
    /// image · video · speech · transcribe — a result that is not a text answer.
    var kind: String?
    var media: AIMedia?
    var stage: String?
    /// Asked while «Приватная беседа» was on: never written to the history.
    var isPrivate = false
}

struct AICapability {
    var enabled: Bool
    var reason: String?
}

struct AIStatus {
    var configured: Bool
    var model: String
    var provider: String
    var platina: Bool
    var capabilities: [String: AICapability]

    var router: Bool { provider == "freellmapi" }
    func can(_ name: String) -> Bool { capabilities[name]?.enabled == true }
}

struct AIStoredConversation {
    var id: String
    var title: String
    var updatedAt: String
    var consent: Bool
    var turns: [AITurn]
}

enum AIModel {
    static let codeTaskPrefix = "Помоги с задачей по коду. Подготовь код или объяснение в виде текста; запуск кода и изменение файлов не запрашиваются.\n\nЗадача пользователя:\n"

    private static func matches(_ pattern: String, _ text: String, options: NSRegularExpression.Options = []) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return false }
        return regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    private static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    static func validModel(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return matches("^[A-Za-z0-9_./:@+-]{1,200}$", text)
    }

    // MARK: Server answers

    static func parseStatus(_ value: Any) throws -> AIStatus {
        guard let status = value as? [String: Any] else { throw AIFailure("AI-сервис вернул некорректный ответ.") }
        let provider = status["provider"] as? String ?? ""
        let model = status["model"] as? String ?? ""
        let providerOk = (provider == "openrouter" && model == "openrouter/free") || (provider == "freellmapi" && validModel(model))
        guard isBool(status["configured"]), providerOk, isBool(status["freeOnly"]), (status["freeOnly"] as? Bool) == true else {
            throw AIFailure("Этот сервер не подтвердил доступ к бесплатному AI.")
        }
        guard let source = status["capabilities"] as? [String: Any] else { throw AIFailure("AI-сервис вернул некорректный ответ.") }
        var capabilities: [String: AICapability] = [:]
        let optional = ["speech", "transcribe", "vision", "models", "documents"]
        for name in ["text", "code", "image", "video", "threeD", "social", "speech", "transcribe", "vision", "models", "documents"] {
            if optional.contains(name) && source[name] == nil {
                capabilities[name] = AICapability(enabled: false, reason: "Этот сервер пока не поддерживает инструмент.")
                continue
            }
            guard let entry = source[name] as? [String: Any] else { throw AIFailure("AI-сервис вернул некорректный ответ.") }
            guard isBool(entry["enabled"]), let enabled = entry["enabled"] as? Bool, entry["reason"] == nil || entry["reason"] is String else {
                throw AIFailure("Сервер не подтвердил доступность AI-инструментов.")
            }
            capabilities[name] = AICapability(enabled: enabled, reason: entry["reason"] as? String)
        }
        let platina = !(isBool(status["platina"]) && (status["platina"] as? Bool) == false)
        return AIStatus(configured: (status["configured"] as? Bool) == true, model: model, provider: provider, platina: platina, capabilities: capabilities)
    }

    static func parseReply(_ value: Any) throws -> AIReply {
        guard let reply = value as? [String: Any] else { throw AIFailure("AI-сервис вернул некорректный ответ.") }
        let text = reply["text"] as? String ?? ""
        let model = reply["model"] as? String ?? ""
        let provider = reply["provider"] as? String ?? ""
        let blank = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if blank || text.utf16.count > AILimits.answer || model.utf16.count > 240 || (provider != "openrouter" && provider != "freellmapi") || (reply["freeOnly"] as? Bool) != true {
            throw AIFailure("AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз.")
        }
        var routed: String?
        if let via = reply["routedVia"] as? String, via.utf16.count <= 200, !via.isEmpty { routed = via }
        return AIReply(text: text, model: model, provider: provider, routedVia: routed)
    }

    static func parseModels(_ value: Any) -> [String] {
        guard let data = value as? [String: Any], let list = data["models"] as? [Any] else { return [] }
        return Array(list.compactMap { $0 as? String }.filter { validModel($0) }.prefix(300))
    }

    /// `{mimeType, base64, routedVia?}` of a picture or speech.
    static func parseMedia(_ value: Any, kinds: String) throws -> (mimeType: String, data: Data, routedVia: String?) {
        guard let data = value as? [String: Any], let mime = data["mimeType"] as? String, matches(kinds, mime),
              let text = data["base64"] as? String, !text.isEmpty, matches("^[A-Za-z0-9+/]+={0,2}$", text), let bytes = Data(base64Encoded: text) else {
            throw AIFailure("AI-сервис вернул некорректный файл.")
        }
        var routed: String?
        if let via = data["routedVia"] as? String, via.utf16.count <= 200 { routed = via }
        return (mime, bytes, routed)
    }

    // MARK: Context

    /// Only successful turns of this conversation are eligible as context.
    static func historyForQuestion(_ turns: [AITurn], _ question: String) throws -> [[String: String]] {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw AIFailure("Напиши вопрос.") }
        if text.utf16.count > AILimits.message { throw AIFailure("Вопрос должен быть не длиннее \(AILimits.message) символов.") }
        var messages: [[String: String]] = []
        for turn in turns {
            guard turn.status == "complete", let answer = turn.answer else { continue }
            messages.append(["role": "user", "content": turn.question])
            messages.append(["role": "assistant", "content": answer.text])
        }
        messages.append(["role": "user", "content": text])
        var total = 0
        var tooLong = false
        for message in messages {
            let length = (message["content"] ?? "").utf16.count
            total += length
            if length > AILimits.message { tooLong = true }
        }
        if messages.count > AILimits.count || tooLong || total > AILimits.history {
            throw AIFailure("Беседа достигла лимита контекста. Начни новую беседу — предыдущий текст не будет обрезан или отправлен частично.")
        }
        return messages
    }

    // MARK: Intent («нарисуй…», «сделай видео…», «озвучь: …»)

    private static let imageNoun = "(картин\\p{L}*|изображени\\p{L}*|рисун\\p{L}*|арт\\p{L}*|иллюстраци\\p{L}*|аватар\\p{L}*|аву|авку|логотип\\p{L}*|лого|обои|обоину|постер\\p{L}*|стикер\\p{L}*|фото\\p{L}*|пикч\\p{L}*|image|picture|art|logo|wallpaper)"
    private static let make = "(сгенериру\\p{L}*|генериру\\p{L}*|создай\\p{L}*|сделай\\p{L}*|нарисуй\\p{L}*|изобрази\\p{L}*|покажи|придумай|draw|generate|create|make)"
    private static let videoNoun = "(видео\\p{L}*|ролик\\p{L}*|клип\\p{L}*|анимаци\\p{L}*|video|clip|animation)"
    private static let speechPattern = "^\\s*(озвучь|озвучи|прочитай вслух|скажи голосом|read aloud|say)(?=[\\s:,.!?]|$)\\s*:?"

    /// text · image · video · speech
    static func detectIntent(_ text: String) -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "text" }
        if matches(speechPattern, value, options: [.caseInsensitive]) { return "speech" }
        if matches(make + "[^.!?\\n]{0,40}?" + videoNoun, value, options: [.caseInsensitive]) { return "video" }
        if matches("^\\s*(нарису\\p{L}*|изобрази\\p{L}*|draw|paint)(?=[\\s:,.!?]|$)", value, options: [.caseInsensitive]) { return "image" }
        if matches(make + "[^.!?\\n]{0,40}?" + imageNoun, value, options: [.caseInsensitive]) { return "image" }
        return "text"
    }

    /// The text to speak for «озвучь: привет» → «привет».
    static func speechText(_ text: String) -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: speechPattern, options: [.caseInsensitive]) else { return value }
        let range = NSRange(location: 0, length: (value as NSString).length)
        return regex.stringByReplacingMatches(in: value, options: [], range: range, withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Media names

    static let mediaPrefix = "linea-ai-"
    static func mediaName(_ uri: String) -> String {
        guard let slash = uri.range(of: "/", options: .backwards) else { return uri }
        return String(uri[slash.upperBound...])
    }
    /// Only files of the AI cache are stored and shown again: a bare name or a file: URI, never `..`, `?`, `#`.
    static func isMediaUri(_ uri: String) -> Bool {
        if uri.contains("?") || uri.contains("#") || uri.contains("..") { return false }
        guard uri.hasPrefix("file:") || !uri.contains("/") else { return false }
        return matches("^linea-ai-[A-Za-z0-9_-]+\\.[a-z0-9]{1,5}$", mediaName(uri))
    }

    // MARK: Stored history (the reference's JSON form, vault entry `ai:v1`)

    static func storedTurns(_ turns: [AITurn]) -> [AITurn] {
        var out: [AITurn] = []
        for turn in turns where !turn.isPrivate {
            var kept = AITurn(id: turn.id, question: turn.question, status: turn.status == "pending" ? "cancelled" : turn.status)
            kept.answer = turn.answer
            if let error = turn.error, !error.isEmpty { kept.error = error }
            kept.model = turn.model
            if let ms = turn.ms, ms.isFinite { kept.ms = ms }
            kept.kind = turn.kind
            if let media = turn.media, isMediaUri(media.uri) { kept.media = AIMedia(uri: mediaName(media.uri), mimeType: media.mimeType) }
            out.append(kept)
        }
        return out
    }

    static func turnJSON(_ turn: AITurn) -> [String: Any] {
        var out: [String: Any] = ["id": turn.id, "question": turn.question, "status": turn.status]
        if let answer = turn.answer { out["answer"] = answer.json }
        if let error = turn.error { out["error"] = error }
        if let model = turn.model { out["options"] = ["model": model] }
        if let ms = turn.ms { out["ms"] = ms.rounded() }
        if let kind = turn.kind { out["kind"] = kind }
        if let media = turn.media { out["media"] = ["uri": media.uri, "mimeType": media.mimeType] }
        return out
    }

    private static func turn(_ value: Any) -> AITurn? {
        guard let item = value as? [String: Any], let number = item["id"] as? NSNumber, !isBool(number), number.doubleValue == number.doubleValue.rounded(), abs(number.doubleValue) < 9_007_199_254_740_992,
              let question = item["question"] as? String, question.utf16.count <= AILimits.message,
              let status = item["status"] as? String, ["complete", "failed", "cancelled"].contains(status) else { return nil }
        var out = AITurn(id: number.intValue, question: question, status: status)
        if let raw = item["answer"] {
            guard let answer = raw as? [String: Any], let text = answer["text"] as? String, text.utf16.count <= AILimits.answer, let model = answer["model"] as? String else { return nil }
            out.answer = AIReply(text: text, model: model, provider: answer["provider"] as? String ?? "freellmapi", routedVia: answer["routedVia"] as? String)
        }
        if let raw = item["media"] {
            guard let media = raw as? [String: Any], let uri = media["uri"] as? String, uri.utf16.count <= 1024, isMediaUri(uri), let mime = media["mimeType"] as? String, mime.utf16.count <= 80 else { return nil }
            out.media = AIMedia(uri: uri, mimeType: mime)
        }
        if let raw = item["error"] {
            guard let error = raw as? String else { return nil }
            out.error = error
        }
        if let options = item["options"] as? [String: Any], let model = options["model"] as? String { out.model = model }
        if let ms = item["ms"] as? NSNumber, !isBool(ms) { out.ms = ms.doubleValue }
        if let kind = item["kind"] as? String { out.kind = kind }
        return out
    }

    private static func date(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let found = precise.date(from: text) { return found }
        return ISO8601DateFormatter().date(from: text)
    }
    static func updated(_ conversation: AIStoredConversation) -> Date { date(conversation.updatedAt) ?? Date() }

    static func parseHistory(_ raw: String?) -> [AIStoredConversation] {
        guard let raw, let data = raw.data(using: .utf8), let list = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [Any] else { return [] }
        var out: [AIStoredConversation] = []
        for value in list {
            guard let item = value as? [String: Any], let id = item["id"] as? String, matches("^[A-Za-z0-9-]{8,64}$", id),
                  let title = item["title"] as? String, title.utf16.count <= 120, let updatedAt = item["updatedAt"] as? String, date(updatedAt) != nil,
                  isBool(item["consent"]), let consent = item["consent"] as? Bool, let rawTurns = item["turns"] as? [Any], !rawTurns.isEmpty, rawTurns.count <= 40 else { continue }
            let turns = rawTurns.compactMap { turn($0) }
            guard turns.count == rawTurns.count else { continue }
            out.append(AIStoredConversation(id: id, title: title, updatedAt: updatedAt, consent: consent, turns: turns))
        }
        out.sort { $0.updatedAt > $1.updatedAt }
        return Array(out.prefix(AILimits.historyMax))
    }

    static func historyJSON(_ list: [AIStoredConversation]) -> String {
        let items: [[String: Any]] = list.map { item in
            let turns: [[String: Any]] = item.turns.map { turnJSON($0) }
            return ["id": item.id, "title": item.title, "updatedAt": item.updatedAt, "consent": item.consent, "turns": turns]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: items, options: []), let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    static func conversationTitle(_ turns: [AITurn]) -> String {
        var first = turns.first?.question ?? ""
        if let regex = try? NSRegularExpression(pattern: "^Помоги с задачей по коду\\.[\\s\\S]*?Задача пользователя:\\n", options: []) {
            first = regex.stringByReplacingMatches(in: first, options: [], range: NSRange(location: 0, length: (first as NSString).length), withTemplate: "")
        }
        first = first.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        if first.isEmpty { first = "Беседа" }
        return first.count > 60 ? String(first.prefix(59)) + "…" : first
    }

    /// Inserts or replaces a conversation, newest first. Empty (or fully private) conversations are not stored.
    static func upsert(_ list: [AIStoredConversation], id: String, turns: [AITurn], consent: Bool, now: String) -> [AIStoredConversation] {
        let rest = list.filter { $0.id != id }
        let stored = storedTurns(turns)
        if stored.isEmpty { return rest }
        let entry = AIStoredConversation(id: id, title: conversationTitle(stored), updatedAt: now, consent: consent, turns: Array(stored.suffix(AILimits.storedTurns)))
        return Array(([entry] + rest).prefix(AILimits.historyMax))
    }

    static func nowISO() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    static func modelLabel(_ id: String) -> String {
        let names = ["auto": "Авто", "auto:smart": "Умная", "auto:fast": "Быстрая", "auto:reliable": "Надёжная", "auto:balanced": "Сбалансированная", "fusion": "Консилиум"]
        if let name = names[id] { return name }
        let last = id.components(separatedBy: "/").last ?? ""
        return last.isEmpty ? id : last
    }

    static let strategies: [(id: String, help: String)] = [
        ("auto:smart", "Для сложных вопросов и кода. Отвечает дольше"),
        ("auto", "Сама выбирает свободную модель"),
        ("auto:fast", "Быстрые ответы на простые вопросы"),
        ("auto:reliable", "Модели, которые реже бывают заняты"),
        ("fusion", "Отвечают несколько моделей, выбирается лучший ответ"),
    ]
}
