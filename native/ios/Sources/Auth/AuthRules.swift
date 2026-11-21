import Foundation

/// The checks of the sign-in screen, as `mobile/src/AuthScreen.tsx` makes them before anything is sent.
/// The server repeats every one of them (`server/src/auth.js`): these only spare a round trip.
enum AuthRules {
    /// A login or a public @username as it is sent: without the spaces around, in lower case.
    static func name(_ typed: String) -> String {
        return typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// 3–24 of a–z, 0–9 and «_» (after `name`).
    static func validName(_ typed: String) -> Bool {
        let scalars = name(typed).unicodeScalars
        guard scalars.count >= 3, scalars.count <= 24 else { return false }
        for scalar in scalars {
            let v = scalar.value
            let letter = v >= 0x61 && v <= 0x7A
            let digit = v >= 0x30 && v <= 0x39
            if !letter && !digit && v != 0x5F { return false }
        }
        return true
    }

    static let nameError = "Логин: 3–24 символа — латинские буквы, цифры и знак _."
    static let passwordEntryError = "Введи свой пароль. Максимум — 128 символов."

    /// The public @username as typed on the profile step: no «@» in front, lower case.
    static func handle(_ typed: String) -> String {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("@") { text.removeFirst() }
        return text.lowercased()
    }

    /// A secret word as it is compared and sent: trimmed, composed (NFC), lower case.
    static func word(_ typed: String) -> String {
        return typed.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping.lowercased()
    }

    /// The password typed at sign-in: not empty, at most 128 symbols.
    static func passwordEntered(_ value: String) -> Bool {
        return !value.isEmpty && value.unicodeScalars.count <= 128
    }

    /// What is wrong with a password being created; empty when nothing is.
    static func newPasswordError(_ value: String) -> String {
        let count = value.precomposedStringWithCanonicalMapping.unicodeScalars.count
        if count < 10 || count > 128 { return "Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу." }
        for scalar in value.unicodeScalars {
            if scalar.value <= 0x1F || scalar.value == 0x7F { return "В пароле есть недопустимый символ." }
        }
        return ""
    }

    /// What is wrong with a secret word; empty when nothing is. The word must differ from the password,
    /// the login and the other word (those not given are not compared).
    static func wordError(_ value: String, password: String = "", login: String = "", otherWord: String = "") -> String {
        let made = word(value)
        let scalars = made.unicodeScalars
        var letters = scalars.count >= 4 && scalars.count <= 64
        for scalar in scalars {
            let v = scalar.value
            let latin = v >= 0x61 && v <= 0x7A
            let russian = (v >= 0x430 && v <= 0x44F) || v == 0x451
            if !latin && !russian { letters = false }
        }
        if !letters { return "Слово: от 4 до 64 русских или английских букв, без пробелов." }
        if same(made, word(password)) || same(made, name(login)) || same(made, word(otherWord)) {
            return "Два слова должны отличаться друг от друга, пароля и логина."
        }
        return ""
    }

    /// Exactly the same symbols (Swift's `==` would also call differently composed texts equal).
    private static func same(_ a: String, _ b: String) -> Bool {
        return a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    /// The time left until `until` (both in milliseconds): `MM:SS`, with the hours in front when there are any.
    static func countdown(until: Double, now: Double) -> String {
        let seconds = Int(max(0, ((until - now) / 1000).rounded(.up)))
        let hours = seconds / 3600
        let rest = String(format: "%02d:%02d", (seconds % 3600) / 60, seconds % 60)
        return hours > 0 ? String(format: "%02d:", hours) + rest : rest
    }
}
