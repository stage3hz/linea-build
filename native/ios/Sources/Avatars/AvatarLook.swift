import UIKit

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Avatars: a person's decorations and the views that draw them — for the chat list, the chat header, profiles,
// mini profiles and member lists. Ported from the reference's platina/Decor.tsx, CodeFrames.tsx, Decorations.tsx,
// Nameplates.tsx, PlatinaMark.tsx, StatusEmoji.tsx, statusEmojiModel.ts and birthday.ts.
//
// HOW TO USE (for every screen):
//
//   let look = PersonLook(rawUser)            // from the server's `user` object ([String: Any]); `Person.look` too
//   let avatar = DecoratedAvatarView()        // Avatars/DecoratedAvatarView.swift
//   avatar.frame.size = CGSize(width: 54, height: 54)   // the avatar's own size; frames and art reach OUTSIDE it
//   avatar.show(person, look: look, base: messenger.server.endpoint, animated: false)
//        animated: false in lists (still frame, still photo, no video — cheap to scroll),
//                  true in profiles / the chat header (turning frames, sweeps, sparks, the silent video avatar).
//        Keep clipsToBounds = false on the avatar's superviews where the art may overhang (it reaches 1.3–1.5×).
//
//   PlatinaNameLabel   — a name in moving platinum when the person has Platina (Avatars/PlatinaMark.swift)
//   PlatinaSealView    — the «PLATINA» seal; a tap opens the showcase (PlatinaShowcase.open(from:owner:))
//   PlatinaGemView     — the small platinum diamond for list rows
//   StatusEmojiView    — the emoji status next to a name, or the diamond for Platina without one (StatusEmoji.swift)
//   NameplateView      — the picture behind a row (Avatars/Nameplates.swift)
//   ChatListDecor.fields(look, name:) — the chat list's row keys (`ring`, `deco`, `decoScale`, `plate`, `metal`,
//                        `nameLen`) for ChatRow.parse, and ChatListDecor.install() bakes the plates and the still
//                        code frames into ChatDecorStore (Avatars/ChatListDecor.swift)
//   PersonLook.birthdayToday / AvatarCatalog.birthdayColors(gender) — the festive ring and header
//
// Owner's rules over the reference: avatars are round everywhere; frames and art are shown in the chat list and in
// profiles (the chat header shows the photo / video avatar with its frame as the reference does).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// A person's decorations, as the server sends them in a `user` (the reference's types.ts `User`).
struct PersonLook: Equatable {
    /// "platina" while the owner's Platina is active.
    var seal = ""
    var avatarFrame = ""
    var avatarVideoId = ""
    var bannerId = ""
    /// "image" or "video".
    var bannerKind = ""
    var bannerPreset = ""
    var profileEffect = ""
    var nameplate = ""
    var profilePattern = ""
    var statusEmoji = ""
    var statusExpiry = StatusField.missing
    var statusPermanent = StatusField.missing
    /// "male", "female" or empty.
    var gender = ""
    /// «MM-DD» or «YYYY-MM-DD»; empty when not set.
    var birthday = ""

    /// A field that may be missing, explicitly null, or a value (the status rules tell them apart).
    enum StatusField: Equatable {
        case missing
        case null
        case text(String)
        case flag(Bool)
        case other
    }

    init() {}

    init(_ raw: Any?) {
        guard let fields = raw as? [String: Any] else { return }
        func text(_ key: String) -> String { return fields[key] as? String ?? "" }
        func field(_ key: String) -> StatusField {
            guard let value = fields[key] else { return .missing }
            if value is NSNull { return .null }
            if let words = value as? String { return .text(words) }
            if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return .flag(number.boolValue) }
            return .other
        }
        seal = text("seal")
        avatarFrame = text("avatarFrame")
        avatarVideoId = text("avatarVideoId")
        bannerId = text("bannerId")
        bannerKind = text("bannerKind")
        bannerPreset = text("bannerPreset")
        profileEffect = text("profileEffect")
        nameplate = text("nameplate")
        profilePattern = text("profilePattern")
        statusEmoji = text("statusEmoji")
        statusExpiry = field("statusEmojiExpiresAt")
        statusPermanent = field("statusEmojiPermanent")
        gender = text("gender")
        birthday = text("birthday")
    }

    var platina: Bool { return seal == "platina" }
    var hasBanner: Bool { return !bannerId.isEmpty || (!bannerPreset.isEmpty && AvatarCatalog.banners.contains { $0.id == bannerPreset }) }
    var birthdayToday: Bool { return AvatarCatalog.isBirthdayToday(birthday) }

    /// The status emoji to show now, or nil (statusEmojiModel.ts `visibleStatusEmoji`, rule for rule): only one of
    /// the fixed set; a permanent one needs the explicit marker and an explicit null expiry; otherwise the expiry
    /// must be a time still ahead. Inconsistent data hides it.
    func visibleStatus(now: Date = Date()) -> String? {
        guard AvatarCatalog.statusEmoji.contains(statusEmoji) else { return nil }
        if statusPermanent == .flag(true) { return statusExpiry == .null ? statusEmoji : nil }
        if statusPermanent != .missing && statusPermanent != .flag(false) { return nil }
        guard case .text(let stamp) = statusExpiry, let at = Messenger.date(stamp), at > now else { return nil }
        return statusEmoji
    }

    /// When the shown status runs out (nil: never, or nothing shown).
    func statusEnds(now: Date = Date()) -> Date? {
        guard visibleStatus(now: now) != nil, statusPermanent != .flag(true), case .text(let stamp) = statusExpiry else { return nil }
        return Messenger.date(stamp)
    }

    /// The same person in full Platina dress (the showcase's «вот так будешь выглядеть ты»).
    func dressed() -> PersonLook {
        var made = self
        made.seal = "platina"
        if made.avatarFrame.isEmpty { made.avatarFrame = "platinum" }
        if made.profileEffect.isEmpty { made.profileEffect = "sparks" }
        return made
    }
}

/// A colour of the reference's catalogues: «#RRGGBB».
func lookColor(_ hex: String, alpha: CGFloat = 1) -> UIColor {
    return UIColor(hex: Messenger.color(hex), alpha: alpha)
}

/// The fixed lists of the reference (and of the server's cosmetics.js): frames, art, banners, plates, effects.
enum AvatarCatalog {
    struct Frame { let id: String; let label: String; let colors: [String] }
    struct Item { let id: String; let label: String }
    struct Decoration { let id: String; let label: String; let collection: String; let file: String; let scale: CGFloat; let sweep: Bool; let glow: String; let particles: String; let rise: Bool }
    struct Plate { let id: String; let label: String; let colors: (String, String) }

    /// Platina avatar frames: a gradient ring that slowly turns around the avatar (Decor.tsx FRAMES).
    static let frames: [Frame] = [
        Frame(id: "platinum", label: "Платина", colors: ["#FFFFFF", "#8D97AA", "#F1F4F9", "#6C7588", "#FFFFFF", "#A7B0C1", "#FFFFFF"]),
        Frame(id: "aurora", label: "Сияние", colors: ["#3FA9F5", "#2EE6C8", "#E8F6FF", "#3FA9F5"]),
        Frame(id: "frost", label: "Иней", colors: ["#BFE6FF", "#FFFFFF", "#6FB6FF", "#BFE6FF"]),
        Frame(id: "ember", label: "Пламя", colors: ["#FF4D3A", "#FFC24B", "#FF2E63", "#FF4D3A"]),
        Frame(id: "emerald", label: "Изумруд", colors: ["#0BAA6F", "#8CF7CF", "#0B6450", "#0BAA6F"]),
        Frame(id: "prism", label: "Призма", colors: ["#4F8CFF", "#2EE6C8", "#FFE066", "#FF6B8A", "#4F8CFF"]),
        Frame(id: "orbit", label: "Орбита", colors: ["#16316A", "#4F8CFF", "#16316A", "#16316A"]),
    ]

    /// Animated frames drawn in code (CodeFrames.tsx CODE_FRAMES).
    static let codeFrames: [Item] = [
        Item(id: "fx-neon", label: "Неон"), Item(id: "fx-flame", label: "Пламя"), Item(id: "fx-stardust", label: "Звёзды"),
        Item(id: "fx-glitch", label: "Глитч"), Item(id: "fx-aurora", label: "Сияние"), Item(id: "fx-lightning", label: "Молнии"),
        Item(id: "fx-hearts", label: "Сердца"), Item(id: "fx-orbit", label: "Орбиты"),
    ]
    /// How far a code frame reaches past the avatar.
    static let codeFrameScale: CGFloat = 1.3

    static let decorationCollections = ["Готика", "Хоррор", "Пламя", "Ночь"]

    /// Hand-painted art around a round avatar (Decorations.tsx DECORATIONS); the files are mobile/assets/decorations.
    static let decorations: [Decoration] = [
        Decoration(id: "deco-black-roses", label: "Чёрные розы", collection: "Готика", file: "decoration-black_roses", scale: 1.282, sweep: true, glow: "", particles: "", rise: false),
        Decoration(id: "deco-white-roses", label: "Белые розы", collection: "Готика", file: "decoration-white_roses", scale: 1.272, sweep: true, glow: "", particles: "#F1E9FF", rise: false),
        Decoration(id: "deco-chrome", label: "Хром", collection: "Готика", file: "decoration-chrome", scale: 1.5, sweep: true, glow: "", particles: "", rise: false),
        Decoration(id: "deco-fangs", label: "Пасть", collection: "Хоррор", file: "decoration-fangs", scale: 1.267, sweep: true, glow: "", particles: "", rise: false),
        Decoration(id: "deco-eye", label: "Глаз", collection: "Хоррор", file: "decoration-eye", scale: 1.5, sweep: true, glow: "", particles: "", rise: false),
        Decoration(id: "deco-ink", label: "Чернила", collection: "Хоррор", file: "decoration-ink", scale: 1.292, sweep: false, glow: "#B9C0CC", particles: "", rise: false),
        Decoration(id: "deco-skulls", label: "Черепа", collection: "Пламя", file: "decoration-skulls", scale: 1.332, sweep: false, glow: "#2FE6FF", particles: "#8CF4FF", rise: true),
        Decoration(id: "deco-eclipse", label: "Затмение", collection: "Пламя", file: "decoration-eclipse_smoke", scale: 1.244, sweep: false, glow: "#FF6A1F", particles: "#FFB35C", rise: true),
        Decoration(id: "deco-corona", label: "Корона", collection: "Пламя", file: "decoration-corona", scale: 1.5, sweep: false, glow: "#FFC13B", particles: "#FFE08A", rise: true),
        Decoration(id: "deco-moon", label: "Лунная ночь", collection: "Ночь", file: "decoration-lavender", scale: 1.482, sweep: false, glow: "#B48CFF", particles: "#F0E6FF", rise: false),
        Decoration(id: "deco-moths", label: "Мотыльки", collection: "Ночь", file: "decoration-moths", scale: 1.5, sweep: false, glow: "#C7A8FF", particles: "#FFFFFF", rise: false),
        Decoration(id: "deco-arch", label: "Арка", collection: "Ночь", file: "decoration-arch", scale: 1.335, sweep: true, glow: "", particles: "#FFE7A3", rise: false),
    ]

    /// Animated banner presets; the colours are MusicAmbientView's palettes (Decor.tsx BANNERS).
    static let banners: [Item] = [
        Item(id: "deep", label: "Глубина"), Item(id: "glacier", label: "Ледник"), Item(id: "aurora", label: "Сияние"),
        Item(id: "ocean", label: "Океан"), Item(id: "mint", label: "Мята"), Item(id: "night", label: "Ночь"),
    ]

    /// Profile effects (Effects.tsx PROFILE_EFFECTS).
    static let effects: [Item] = [
        Item(id: "snow", label: "Снег"), Item(id: "sparks", label: "Искры"), Item(id: "petals", label: "Лепестки"),
        Item(id: "bubbles", label: "Пузырьки"), Item(id: "stars", label: "Звёзды"), Item(id: "embers", label: "Угольки"),
    ]

    /// Nameplates (Nameplates.tsx NAMEPLATES).
    static let plates: [Plate] = [
        Plate(id: "crows", label: "Вороны", colors: ("#2B2F36", "#69717E")),
        Plate(id: "leopard", label: "Барс", colors: ("#3A3A3E", "#A4A4AA")),
        Plate(id: "sparkle", label: "Блеск", colors: ("#0B0B12", "#3E3858")),
        Plate(id: "deep", label: "Глубина", colors: ("#06122E", "#1D4596")),
        Plate(id: "aurora", label: "Сияние", colors: ("#040A16", "#0E2A3A")),
        Plate(id: "ember", label: "Пламя", colors: ("#1A0603", "#5E1606")),
        Plate(id: "night", label: "Ночь", colors: ("#070616", "#2A1C66")),
        Plate(id: "sakura", label: "Сакура", colors: ("#24091A", "#6E2249")),
        Plate(id: "mint", label: "Мята", colors: ("#03201A", "#0F5C46")),
        Plate(id: "platinum", label: "Платина", colors: ("#22262E", "#8E97A8")),
    ]

    /// The emoji a status may be (statusEmojiModel.ts STATIC_STATUS_EMOJI).
    static let statusEmoji: [String] = ["✨", "⭐", "🌙", "☀️", "🌊", "🌿", "🔥", "💎", "🪐", "🎧", "🎮", "🦋", "🌛", "🌞", "🎶", "👾", "⚡", "❄️", "🌈", "👑"]

    /// Background patterns of the profile header (ProfilePosts.tsx PROFILE_PATTERNS).
    static let patterns: [String] = ["⭐", "❤️", "🌸", "🔥", "🌙", "⚡", "🍀", "🎵", "👑", "💎", "🦋", "🐾", "☁️", "❄️", "🌊", "🍒", "👻", "💀", "🎮", "🚀", "🌈", "🍕", "🐱", "🦊"]

    static func frame(_ id: String) -> Frame? { return frames.first { $0.id == id } }
    static func decoration(_ id: String) -> Decoration? { return id.isEmpty ? nil : decorations.first { $0.id == id } }
    static func isCodeFrame(_ id: String) -> Bool { return !id.isEmpty && codeFrames.contains { $0.id == id } }
    static func plate(_ id: String) -> Plate? { return plates.first { $0.id == id } }

    /// The picture of a decoration, from the app's bundle (decoded once).
    private static var pictures: [String: UIImage] = [:]
    static func picture(_ decoration: Decoration) -> UIImage? {
        if let hit = pictures[decoration.file] { return hit }
        guard let address = Bundle.main.url(forResource: decoration.file, withExtension: "webp"), let image = UIImage(contentsOfFile: address.path) else { return nil }
        pictures[decoration.file] = image
        return image
    }

    /// The bundle path of a decoration's picture (the chat list loads its art by a file path).
    static func picturePath(_ decoration: Decoration) -> String {
        return Bundle.main.url(forResource: decoration.file, withExtension: "webp")?.path ?? ""
    }

    /// Festive ring colours for a birthday: blue (male), pink (female), or bright confetti (Decor.tsx birthdayColors).
    static func birthdayColors(_ gender: String) -> [String] {
        if gender == "male" { return ["#2F7BFF", "#7CC4FF", "#BFE6FF", "#4A8CFF", "#2F7BFF"] }
        if gender == "female" { return ["#FF5FA2", "#FFB3D6", "#FFD6E9", "#FF7EB8", "#FF5FA2"] }
        return ["#FF5F6D", "#FFC371", "#7CE38B", "#5FA8FF", "#C38BFF", "#FF5F6D"]
    }

    /// The ring a person wears now: their birthday's, their chosen frame, or the platinum one for Platina without a
    /// choice (Decor.tsx). Nil: no ring (no frame, or the frame is art or drawn in code).
    static func ringColors(_ look: PersonLook) -> [String]? {
        if look.birthdayToday { return birthdayColors(look.gender) }
        let id = !look.avatarFrame.isEmpty ? look.avatarFrame : (look.platina ? "platinum" : "")
        return frame(id)?.colors
    }

    // MARK: Birthdays (birthday.ts)

    /// Is it this person's birthday today (on this phone's calendar)? 29 Feb is celebrated on 28 Feb in other years.
    static func isBirthdayToday(_ value: String, now: Date = Date()) -> Bool {
        guard let made = BirthdayWords.parse(value), made.month >= 1, made.month <= 12 else { return false }
        let calendar = Calendar.current
        let year = calendar.component(.year, from: now)
        let day = made.month == 2 && made.day == 29 && BirthdayWords.daysInMonth(2, year: year) == 28 ? 28 : made.day
        return calendar.component(.month, from: now) == made.month && calendar.component(.day, from: now) == day
    }

    /// The next local midnight of this birthday, today included.
    static func nextBirthday(_ value: String, now: Date = Date()) -> Date? {
        guard let made = BirthdayWords.parse(value), made.month >= 1, made.month <= 12 else { return nil }
        let calendar = Calendar.current
        func at(_ year: Int) -> Date? {
            var parts = DateComponents()
            parts.year = year
            parts.month = made.month
            parts.day = made.month == 2 && made.day == 29 && BirthdayWords.daysInMonth(2, year: year) == 28 ? 28 : made.day
            return calendar.date(from: parts)
        }
        let year = calendar.component(.year, from: now)
        let today = calendar.startOfDay(for: now)
        if let thisYear = at(year), thisYear >= today { return thisYear }
        return at(year + 1)
    }
}
