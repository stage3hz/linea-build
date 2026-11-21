import UIKit

/// Up to three emoji with no other text are shown large, as stickers (the reference's messageMeta.ts
/// `bigEmojiCount`, and the sizes of MessageRow.tsx: 64 pt for one, 52 for two, 44 for three).
enum BigEmoji {
    /// How many emoji the text is (1…3), or 0 when it is not only emoji.
    static func count(_ value: String) -> Int {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.utf16.count > 40 { return 0 }
        // Grapheme by grapheme, white space left out.
        let parts = trimmed.filter { !$0.isWhitespace }
        if parts.isEmpty || parts.count > 3 { return 0 }
        for part in parts where !emoji(part) { return 0 }
        return parts.count
    }

    /// A pictograph or a regional indicator, and nothing of a letter or a digit once the variation selector and
    /// the keycap mark are left out (so «1️⃣» is not one, «❤️» is).
    private static func emoji(_ part: Character) -> Bool {
        var pictured = false
        for scalar in part.unicodeScalars {
            let value = scalar.value
            if value == 0xFE0F || value == 0x20E3 { continue }
            switch scalar.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber:
                return false
            default:
                break
            }
            if (0x1F1E6...0x1F1FF).contains(value) || (value > 0x7F && scalar.properties.isEmoji) { pictured = true }
        }
        return pictured
    }

    /// The size of the emoji for their count.
    static func fontSize(_ count: Int) -> CGFloat { count == 1 ? 64 : count == 2 ? 52 : 44 }
}
