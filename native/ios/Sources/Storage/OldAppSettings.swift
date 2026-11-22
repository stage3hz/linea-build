import Foundation
import CryptoKit

/// The choices the person made in the previous app, carried over once at the first start after the update.
///
/// The previous app kept them in React Native's AsyncStorage (@react-native-async-storage/async-storage 2.2,
/// ios/RNCAsyncStorage.mm): `Application Support/<bundle id>/RCTAsyncLocalStorage_V1/manifest.json`, one JSON object
/// of key → text; a text longer than 1024 characters is `null` there and kept in a file of the same folder named by
/// the MD5 of the key (lowercase hex). The library's earlier place was `Documents/RCTAsyncLocalStorage_V1`; it is
/// read when the new one is missing. The old storage is only READ, never changed or removed.
///
/// Each value is written under the key this app reads, in the form it reads (the same JSON text; a list or a table
/// where this app keeps one), and only where this app has nothing yet — a choice made in this app always wins, and
/// a later run (the next update) changes nothing. Done once: a mark is kept when it has run.
enum OldAppSettings {
    private static let mark = "invizent.old-settings-imported.v1"

    private enum Form { case text, list, table }
    /// The previous app's key (or prefix ending in ":" / ".", for per-account entries), this app's key, the form.
    private static let table: [(old: String, new: String, form: Form)] = [
        ("linea.notification-prefs.v1", "invizent.notification-prefs.v1", .text), // «Уведомления и звуки»
        ("linea.chat-preferences.v1", "invizent.chat-preferences.v1", .text),     // text size, power saving, night theme, accent, effects…
        ("linea.theme.v1", "invizent.theme.v1", .text),                           // «Оформление»: the theme
        ("linea.dark-theme.v1", "invizent.dark-theme.v1", .text),                 // the night theme
        ("linea.wallpapers.v1", "invizent.wallpapers.v1", .text),                 // chat wallpapers
        ("linea.stickers.recent.v1", "invizent.emoji.recent.v1", .list),          // recent emoji
        ("linea.language.v1", "linea.language.v1", .text),                        // «Язык»
        ("linea.folders.v1:", "linea.folders.v1:", .text),                        // «Папки с чатами», per account
        ("linea.hidden.v1:", "invizent.hidden.v1:", .list),                       // messages deleted for me, per account
        ("linea.removed-chats.v1:", "invizent.removed-chats.v1:", .table),        // chats deleted for me, per account
        ("linea.marked-unread.v1:", "invizent.marked-unread.v1:", .list),         // chats marked unread, per account
        ("linea.seen-posts.v1:", "linea.seen-posts.v1:", .text),                  // stories seen, per account
        ("linea.recent-search.v1:", "linea.recent-search.v1:", .text),            // recent search, per account
        ("linea.platina.seen.", "linea.platina.seen.", .text),                    // Platina offer seen, per account
        ("linea.channel-outbox.v1:", "linea.channel-outbox.v1:", .text),          // channel messages not sent yet, per account
        ("linea.hint.bar-scrub.v1", "linea.hint.bar-scrub.v1", .text),            // the tab bar hint shown
        ("linea.equalizer.v1", "linea.equalizer.v1", .text),                      // music: equalizer
        ("linea.music-source.v1", "linea.music-source.v1", .text),                // music: the chosen source
        ("linea.music.device-library.v1", "linea.music.device-library.v1", .text),// music: saved tracks and favourites
        ("linea.session-user.v1", "invizent.session-user.v1", .text),             // the account's last profile (opens at once)
    ]

    /// At launch, before anything reads its settings.
    static func importOnce() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: mark) else { return }
        defer { defaults.set(true, forKey: mark) }
        guard let old = read() else { return }
        for (key, value) in old {
            guard let entry = table.first(where: { key == $0.old || (($0.old.hasSuffix(":") || $0.old.hasSuffix(".")) && key.hasPrefix($0.old)) }) else { continue }
            let target = entry.new + String(key.dropFirst(entry.old.count))
            guard defaults.object(forKey: target) == nil else { continue }
            switch entry.form {
            case .text:
                defaults.set(value, forKey: target)
            case .list:
                if let list = (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [Any] { defaults.set(list.compactMap { $0 as? String }, forKey: target) }
            case .table:
                if let found = (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any] {
                    var kept: [String: Int] = [:]
                    for (chatId, number) in found { if let id = number as? NSNumber { kept[chatId] = id.intValue } }
                    defaults.set(kept, forKey: target)
                }
            }
        }
    }

    /// The previous app's AsyncStorage as key → text; nil when there is none.
    static func read() -> [String: String]? {
        let files = FileManager.default
        var folders: [URL] = []
        if let support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first, let bundle = Bundle.main.bundleIdentifier {
            folders.append(support.appendingPathComponent(bundle, isDirectory: true).appendingPathComponent("RCTAsyncLocalStorage_V1", isDirectory: true))
        }
        if let documents = files.urls(for: .documentDirectory, in: .userDomainMask).first {
            folders.append(documents.appendingPathComponent("RCTAsyncLocalStorage_V1", isDirectory: true))
        }
        for folder in folders {
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
                  let manifest = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            var out: [String: String] = [:]
            for (key, value) in manifest {
                if let text = value as? String { out[key] = text; continue }
                // A long value: its own file, named by the MD5 of the key.
                let name = Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
                if let text = try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8) { out[key] = text }
            }
            return out
        }
        return nil
    }
}
