import Foundation

/// The channel messages waiting for a connection, kept on this device per account so they survive a restart —
/// the same records and keys as the reference (`mobile/src/communities/channelOutbox.ts`: `linea.channel-outbox.v1:<user>`
/// for the queue, `…:failed` for what the server refused for good, at most 20). Anything malformed is dropped.
/// Channel messages are not end-to-end encrypted (the server keeps them), so they are kept as plain JSON like there.
enum ChannelOutboxDisk {
    private static let prefix = "linea.channel-outbox.v1"

    static func load(userId: String) -> (waiting: [ChannelOutbox.Item], refused: [(item: ChannelOutbox.Item, words: String)]) {
        let defaults = UserDefaults.standard
        let waiting = parse(defaults.string(forKey: prefix + ":" + userId))
        var refused: [(item: ChannelOutbox.Item, words: String)] = []
        if let raw = defaults.string(forKey: prefix + ":" + userId + ":failed"), let data = raw.data(using: .utf8),
           let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
            for entry in list {
                guard let fields = entry["item"] as? [String: Any], let item = item(fields) else { continue }
                if refused.contains(where: { (old: (item: ChannelOutbox.Item, words: String)) -> Bool in old.item.key == item.key }) { continue }
                let words = entry["error"] as? String ?? ""
                refused.append((item: item, words: words.isEmpty ? "Не удалось отправить." : words))
            }
        }
        return (waiting: Array(waiting.prefix(ChannelOutbox.limit)), refused: Array(refused.suffix(20)))
    }

    static func save(userId: String, waiting: [ChannelOutbox.Item], refused: [(item: ChannelOutbox.Item, words: String)]) {
        let defaults = UserDefaults.standard
        let now = ISO8601DateFormatter().string(from: Date())
        let queue = waiting.map { (item: ChannelOutbox.Item) -> [String: Any] in fields(item, now: now) }
        let failed = refused.map { (entry: (item: ChannelOutbox.Item, words: String)) -> [String: Any] in ["item": fields(entry.item, now: now), "error": entry.words, "failedAt": now] }
        write(queue.isEmpty ? nil : queue, key: prefix + ":" + userId, defaults: defaults)
        write(failed.isEmpty ? nil : failed, key: prefix + ":" + userId + ":failed", defaults: defaults)
    }

    private static func write(_ list: [[String: Any]]?, key: String, defaults: UserDefaults) {
        guard let list, let data = try? JSONSerialization.data(withJSONObject: list), let text = String(data: data, encoding: .utf8) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(text, forKey: key)
    }

    private static func fields(_ item: ChannelOutbox.Item, now: String) -> [String: Any] {
        var out: [String: Any] = ["key": item.key, "communityId": item.communityId, "channelId": item.channelId, "text": item.text, "createdAt": now]
        if item.replyTo != 0 { out["replyTo"] = item.replyTo }
        return out
    }

    private static func item(_ fields: [String: Any]) -> ChannelOutbox.Item? {
        guard let key = fields["key"] as? String, !key.isEmpty, key.count <= 64,
              let community = fields["communityId"] as? String, let channel = fields["channelId"] as? String,
              let text = fields["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let reply = (fields["replyTo"] as? NSNumber)?.intValue ?? 0
        return ChannelOutbox.Item(key: key, communityId: community, channelId: channel, text: text, replyTo: reply)
    }

    private static func parse(_ raw: String?) -> [ChannelOutbox.Item] {
        guard let raw, let data = raw.data(using: .utf8), let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        var seen = Set<String>()
        var out: [ChannelOutbox.Item] = []
        for fields in list {
            guard let made = item(fields), !seen.contains(made.key) else { continue }
            seen.insert(made.key)
            out.append(made)
        }
        return out
    }
}
