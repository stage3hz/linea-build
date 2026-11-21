import UIKit

/// What the chat list (Chats/ChatList.swift, which draws each row in one pass) needs to show a person's decoration:
/// the row keys of `ChatRow.parse` and the pictures it looks up in `ChatDecorStore`.
///
///   ChatListDecor.install()                       once (it is cheap to call again): the ten nameplates and the eight
///                                                 code frames' still pictures go into ChatDecorStore
///   row.merge(ChatListDecor.fields(look, name: displayName)) { _, new in new }
///                                                 `ring` (ARGB colours), `deco` + `decoScale`, `plate`, `metal` + `nameLen`
///
/// As the reference's list: frames and art are still there (they move in profiles); the plate is darkened towards
/// the name by the row itself.
enum ChatListDecor {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        var pictures: [String: String] = [:]
        for plate in AvatarCatalog.plates {
            if let made = Nameplates.base64(plate.id) { pictures[plate.id] = made }
        }
        // The list's avatar is 60 pt: the still code frames are drawn for it.
        for frame in AvatarCatalog.codeFrames {
            if let still = CodeFrameView.still(frame.id, avatar: 60), let png = still.pngData() { pictures[frame.id] = png.base64EncodedString() }
        }
        _ = ChatDecorStore.shared.setPlates(pictures)
    }

    /// The row keys for a person's decoration; `name` is the person's display name (the row's title begins with it).
    static func fields(_ look: PersonLook, name: String) -> [String: Any] {
        var made: [String: Any] = [:]
        let birthday = look.birthdayToday
        if !birthday && AvatarCatalog.isCodeFrame(look.avatarFrame) {
            made["deco"] = look.avatarFrame
            made["decoScale"] = Double(AvatarCatalog.codeFrameScale)
        } else if !birthday, let decoration = AvatarCatalog.decoration(look.avatarFrame) {
            let path = AvatarCatalog.picturePath(decoration)
            if !path.isEmpty {
                made["deco"] = path
                made["decoScale"] = Double(decoration.scale)
            }
        } else if let colors = AvatarCatalog.ringColors(look) {
            made["ring"] = PlatinaMetal.argb(colors)
        }
        if AvatarCatalog.plate(look.nameplate) != nil { made["plate"] = look.nameplate }
        if look.platina {
            // On a plate (dark art) the light metal, also in a light theme.
            made["metal"] = PlatinaMetal.argb(!look.nameplate.isEmpty || Theme.dark ? PlatinaMetal.name : PlatinaMetal.nameLight)
            made["nameLen"] = (name as NSString).length
        }
        return made
    }
}
