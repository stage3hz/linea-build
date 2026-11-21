import Foundation

// Screen sharing in a voice channel: the reference's communities/screenShareModel.ts, word for word where it has words.

/// The two qualities the reference offers (`SCREEN_QUALITIES`): the size the sharing phone's extension scales the
/// picture to (its long edge), sixty frames a second, and the most bits a second the picture may take.
enum ScreenQuality: String {
    case p720 = "720p60"
    case p1080 = "1080p60"

    var width: Int { self == .p720 ? 1280 : 1920 }
    var height: Int { self == .p720 ? 720 : 1080 }
    var frameRate: Int { 60 }
    var maxBitrate: Int { self == .p720 ? 4_000_000 : 8_000_000 }
    /// «720p · 60 FPS» / «1080p · 60 FPS», as the panel says it.
    var label: String { self == .p720 ? "720p · 60 FPS" : "1080p · 60 FPS" }

    /// `screenQuality`: only the two known values.
    static func parse(_ value: Any?) -> ScreenQuality? {
        guard let text = value as? String else { return nil }
        return ScreenQuality(rawValue: text)
    }
}

enum ScreenShareModel {
    /// The sound of a shared computer, bits a second (`SCREEN_AUDIO_BITRATE`).
    static let screenAudioBitrate = 128_000

    /// `screenControl`: `{"type":"screen","active":…,"quality":…}` from a person's peer-to-peer channel, or nil.
    static func control(_ raw: String) -> (active: Bool, quality: ScreenQuality)? {
        guard raw.utf16.count <= 256, let data = raw.data(using: .utf8),
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              value["type"] as? String == "screen", let active = value["active"] as? Bool,
              let quality = ScreenQuality.parse(value["quality"]) else { return nil }
        return (active: active, quality: quality)
    }

    /// The words of a peer-to-peer channel message (JSON); nil when it cannot be written.
    static func json(_ value: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return nil }
        return text
    }

    /// `stereoScreenAudio`: stereo for the shared computer's sound. Opus sends stereo only when the other side's SDP
    /// says stereo=1 (RFC 7587 §6.1); only the second audio section is marked — the reserved slot for the computer's
    /// sound (the video slot, then the microphone, then this one, in both the offer and the answer). The microphone
    /// stays mono voice.
    static func stereoScreenAudio(_ sdp: String, bitrate: Int = 128_000) -> String {
        if sdp.isEmpty { return sdp }
        let eol = sdp.contains("\r\n") ? "\r\n" : "\n"
        let lines = sdp.components(separatedBy: eol)
        var starts: [Int] = []
        for (index, line) in lines.enumerated() where line.hasPrefix("m=") { starts.append(index) }
        let audio = starts.filter { (index: Int) -> Bool in lines[index].hasPrefix("m=audio") }
        if audio.count < 2 { return sdp }
        let start = audio[1]
        let end = starts.first(where: { (index: Int) -> Bool in index > start }) ?? lines.count
        var section = Array(lines[start..<end])
        var payload: String?
        for line in section {
            guard line.lowercased().hasPrefix("a=rtpmap:") else { continue }
            let rest = line.dropFirst("a=rtpmap:".count)
            guard let space = rest.firstIndex(of: " ") else { continue }
            let number = String(rest[rest.startIndex..<space])
            let codec = rest[rest.index(after: space)...].lowercased()
            if !number.isEmpty, number.allSatisfy({ (c: Character) -> Bool in c.isASCII && c.isNumber }), codec.hasPrefix("opus/48000/2") {
                payload = number
                break
            }
        }
        guard let pt = payload else { return sdp }
        let wanted: [(String, String)] = [("stereo", "1"), ("sprop-stereo", "1"), ("maxaveragebitrate", String(bitrate))]
        func merge(_ existing: String) -> String {
            var keys: [String] = []
            var values: [String: String] = [:]
            for part in existing.split(separator: ";") {
                let item = part.trimmingCharacters(in: .whitespaces)
                if item.isEmpty { continue }
                var key = item, value = ""
                if let equal = item.firstIndex(of: "=") {
                    key = String(item[item.startIndex..<equal])
                    value = String(item[item.index(after: equal)...])
                }
                if values[key] == nil { keys.append(key) }
                values[key] = value
            }
            for (key, value) in wanted {
                if values[key] == nil { keys.append(key) }
                values[key] = value
            }
            return keys.map { (key: String) -> String in
                let value = values[key] ?? ""
                return value.isEmpty ? key : key + "=" + value
            }.joined(separator: ";")
        }
        let fmtp = "a=fmtp:\(pt) "
        if let at = section.firstIndex(where: { (line: String) -> Bool in line.hasPrefix(fmtp) }) {
            section[at] = fmtp + merge(String(section[at].dropFirst(fmtp.count)))
        } else {
            let rtpmap = "a=rtpmap:\(pt) "
            let after = (section.firstIndex(where: { (line: String) -> Bool in line.hasPrefix(rtpmap) }) ?? -1) + 1
            section.insert(fmtp + merge(""), at: after)
        }
        return (Array(lines[0..<start]) + section + Array(lines[end...])).joined(separator: eol)
    }
}
