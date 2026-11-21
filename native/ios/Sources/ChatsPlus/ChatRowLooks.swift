import UIKit

/// ChatsPlus: what a chat row shows beyond its words — the reference's ChatListScreen.tsx `nativeThumb`,
/// `listAttachment` (voice/voice.ts) and the decoration fields of `nativeRows`: the small picture of a photo, a video
/// or a round video before the preview, the microphone of a voice message, the person's status emoji after the
/// name, the Platina metal of the name, and the server fields the avatar decorations are made from.
enum ChatRowLooks {
    // MARK: Attachments

    /// voice.ts `isVoice`: `audio/mp4` named `voice-<digits>.m4a`.
    static func isVoice(_ attachment: [String: Any]) -> Bool {
        let name = attachment["name"] as? String ?? ""
        return attachment["mimeType"] as? String == "audio/mp4" && name.range(of: "^voice-[0-9]{1,16}\\.m4a$", options: .regularExpression) != nil
    }

    /// voice.ts `isVideoNote`: `video/mp4` named `circle-<digits>.mp4`.
    static func isVideoNote(_ attachment: [String: Any]) -> Bool {
        let name = attachment["name"] as? String ?? ""
        return attachment["mimeType"] as? String == "video/mp4" && name.range(of: "^circle-[0-9]{1,16}\\.mp4$", options: .regularExpression) != nil
    }

    /// voice.ts `listAttachment`: the words of a file-only message in the list, and "mic" for a voice message.
    static func attachmentLine(_ attachment: [String: Any]) -> (text: String, icon: String) {
        let type = attachment["mimeType"] as? String ?? ""
        if isVoice(attachment) { return ("Голосовое сообщение", "mic") }
        if isVideoNote(attachment) { return ("Видеосообщение", "") }
        if type.hasPrefix("image/") { return ("Фотография", "") }
        if type.hasPrefix("video/") { return ("Видео", "") }
        return (attachmentLabel(attachment), "")
    }

    /// voice.ts `attachmentLabel` for the remaining kinds: the file's own name.
    private static func attachmentLabel(_ attachment: [String: Any]) -> String {
        let type = attachment["mimeType"] as? String ?? ""
        if type.hasPrefix("audio/") { return "🎵 " + (attachment["name"] as? String ?? "Аудио") }
        return "📎 " + (attachment["name"] as? String ?? "Файл")
    }

    /// The line of a chat whose last message is shown as it is (no typing, no draft, no line found elsewhere):
    /// a message with only a photo, a video or a round video gets its small picture and «Фотография» / «Видео» /
    /// «Видеосообщение»; a voice message the microphone; any other file its name.
    static func applyMedia(_ row: inout [String: Any], last: [String: Any]) {
        guard let attachment = last["attachment"] as? [String: Any] else { return }
        let words = Core.view("chatListText", [last]) as? String ?? ""
        // A message with words, or a finished call, keeps its own line (and no picture), as in the reference.
        if !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
        if (last["meta"] as? [String: Any])?["action"] != nil { return }
        let line = attachmentLine(attachment)
        row["preview"] = line.text
        row["previewIcon"] = line.icon
        let type = attachment["mimeType"] as? String ?? ""
        let round = isVideoNote(attachment)
        if let preview = attachment["preview"] as? [String: Any], let base64 = preview["base64"] as? String, !base64.isEmpty,
           round || type.hasPrefix("image/") || type.hasPrefix("video/") {
            row["thumb"] = base64
            row["thumbRound"] = round
        }
    }

    // MARK: The person

    /// statusEmojiModel.ts: the emoji a person may show, and when.
    static let statusEmoji: Set<String> = ["✨", "⭐", "🌙", "☀️", "🌊", "🌿", "🔥", "💎", "🪐", "🎧", "🎮", "🦋", "🌛", "🌞", "🎶", "👾", "⚡", "❄️", "🌈", "👑"]

    /// The reference's `visibleStatusEmoji`: an emoji of the set, permanent with an exactly null expiry, or with an
    /// expiry still ahead; anything inconsistent hides.
    static func visibleStatus(_ peer: [String: Any], now: Date = Date()) -> String? {
        guard let emoji = peer["statusEmoji"] as? String, statusEmoji.contains(emoji) else { return nil }
        let expiry = peer["statusEmojiExpiresAt"]
        if let permanent = peer["statusEmojiPermanent"] as? Bool, permanent { return expiry is NSNull ? emoji : nil }
        if let marker = peer["statusEmojiPermanent"], !(marker is NSNull), (marker as? Bool) != false { return nil }
        guard let text = expiry as? String, let end = Messenger.date(text), end > now else { return nil }
        return emoji
    }

    /// PlatinaMark.tsx NAME_METAL (dark) and NAME_METAL_LIGHT.
    static let nameMetal: [Int] = [0xFFC9D0DC, 0xFFFFFFFF, 0xFF9AA4B6, 0xFFF3F5F9, 0xFFC9D0DC, 0xFFFFFFFF, 0xFF9AA4B6]
    static let nameMetalLight: [Int] = [0xFF3B4352, 0xFF7D889C, 0xFF262C37, 0xFF5E687B, 0xFF3B4352, 0xFF8A95A8, 0xFF262C37]

    /// platina/Decor.tsx FRAMES: the colour rings (the art decorations and the frames drawn in code are the
    /// avatar views' business, see `avatarDecor`).
    static let frames: [String: [Int]] = [
        "platinum": [0xFFFFFFFF, 0xFF8D97AA, 0xFFF1F4F9, 0xFF6C7588, 0xFFFFFFFF, 0xFFA7B0C1, 0xFFFFFFFF],
        "aurora": [0xFF3FA9F5, 0xFF2EE6C8, 0xFFE8F6FF, 0xFF3FA9F5],
        "frost": [0xFFBFE6FF, 0xFFFFFFFF, 0xFF6FB6FF, 0xFFBFE6FF],
        "ember": [0xFFFF4D3A, 0xFFFFC24B, 0xFFFF2E63, 0xFFFF4D3A],
        "emerald": [0xFF0BAA6F, 0xFF8CF7CF, 0xFF0B6450, 0xFF0BAA6F],
        "prism": [0xFF4F8CFF, 0xFF2EE6C8, 0xFFFFE066, 0xFFFF6B8A, 0xFF4F8CFF],
        "orbit": [0xFF16316A, 0xFF4F8CFF, 0xFF16316A, 0xFF16316A],
    ]

    /// Avatars: set by the avatar views (Sources/Avatars) once they exist. Gets the row and the chat's `peer` as the
    /// server sends it, and fills what it draws: `deco` + `decoScale` (an art decoration or a frame drawn in
    /// code), `plate` (a nameplate id whose picture is in ChatDecorStore), and may replace `ring`.
    /// HOOK(Avatars): until it is set, a row shows the colour rings above and the Platina name only.
    static var avatarDecor: ((inout [String: Any], [String: Any]) -> Void)?

    /// The person's part of a row (the reference's `nativeRows`): the status emoji after the name, the Platina
    /// metal over the name's letters, the colour ring of the frame (Platina without a chosen frame wears the
    /// platinum one), and the raw server fields for the avatar views.
    static func applyPerson(_ row: inout [String: Any], peer: [String: Any]) {
        let name = peer["displayName"] as? String ?? (row["title"] as? String ?? "")
        let status = visibleStatus(peer)
        row["title"] = name + (status.map { " " + $0 } ?? "")
        let frame = peer["avatarFrame"] as? String ?? ""
        let seal = peer["seal"] as? String ?? ""
        let plate = peer["nameplate"] as? String ?? ""
        row["frameId"] = frame
        row["seal"] = seal
        row["nameplateId"] = plate
        if seal == "platina" {
            row["metal"] = !plate.isEmpty || Theme.dark ? nameMetal : nameMetalLight
            row["nameLen"] = (name as NSString).length
        }
        let ringId = frame.isEmpty ? (seal == "platina" ? "platinum" : "") : frame
        if let colors = frames[ringId] { row["ring"] = colors }
        if let decorate = avatarDecor { decorate(&row, peer) }
    }
}
