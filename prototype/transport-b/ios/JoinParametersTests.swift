// Host-only regression tests. No Go binding, credentials, sessions or network required.
import Foundation

@main
struct JoinParametersTests {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }

    static func decode(_ parameters: StageBJoinParameters) throws -> [String: Any] {
        return try JSONSerialization.jsonObject(with: Data(parameters.encoded().utf8)) as! [String: Any]
    }

    static func main() throws {
        let wb = StageBJoinParameters(joinLink: "wbstream://room_123456")!
        check(wb.provider == .wbstream, "WB provider")
        let wbPayload = try decode(wb)
        check(wbPayload["roomId"] as? String == "room_123456", "WB room identifier")
        check(wbPayload["tunnelMode"] as? String == "dc", "WB data channel mode")
        check(wbPayload["joinLink"] == nil, "WB must not use a Telemost payload")

        let tmLink = "https://telemost.yandex.ru/j/12345678901234567890"
        let tm = StageBJoinParameters(joinLink: tmLink)!
        check(tm.provider == .telemost, "Telemost provider")
        let tmPayload = try decode(tm)
        check(tmPayload["joinLink"] as? String == tmLink, "Telemost complete join URI")
        check(tmPayload["roomId"] == nil && tmPayload["tunnelMode"] == nil,
              "Telemost must not use WB room or DC mode")
        for payload in [wbPayload, tmPayload] {
            check(payload["displayName"] as? String == "INVIZENT", "Display name")
            check(payload["vp8Fps"] as? Int == 0 && payload["vp8Batch"] as? Int == 0,
                  "Pinned upstream pacing defaults")
            check(payload["reliable"] as? Bool == true, "Reliable transport")
            check(payload["dualTrack"] as? Bool == false, "Single track")
        }

        for invalid in [
            "", "wbstream://short", "wbstream://../../secret", "wbstream://room_123456\n",
            "wbstream://" + String(repeating: "a", count: 161),
            "https://telemost.yandex.ru/j/", "https://telemost.yandex.ru/j/abc",
            "https://telemost.yandex.ru/j/" + String(repeating: "1", count: 161),
            "https://telemost.yandex.ru/j/１２３", tmLink + "\n", tmLink + "\r\n",
            tmLink + "?redirect=https://example.com", tmLink + "#fragment", tmLink + "/extra",
            "https://telemost.yandex.ru.evil.test/j/123", "https://evil.test/j/123",
            "https://telemost.yandex.ru@evil.test/j/123", "https://user@telemost.yandex.ru/j/123",
            "https://telemost.yandex.ru:443/j/123", "https://telemost.yandex.ru./j/123",
            "http://telemost.yandex.ru/j/123", "HTTPS://telemost.yandex.ru/j/123",
            "https://telemost.yandex.ru/j/%31", " https://telemost.yandex.ru/j/123",
            "https://telemost.yandex.ru/j/123\u{0000}"
        ] {
            check(StageBJoinParameters(joinLink: invalid) == nil, "Untrusted join link accepted")
        }
        check(StageBJoinParameters(joinLink: "https://telemost.yandex.ru/j/1") != nil,
              "Shortest numeric room")
        check(StageBJoinParameters(joinLink: "https://telemost.yandex.ru/j/" + String(repeating: "1", count: 160)) != nil,
              "Maximum numeric room")
        print("Native join parameter validation and provider payload tests passed.")
    }
}
