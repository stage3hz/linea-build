// Shared validation and provider-specific parameters. No network operation occurs here.
import Foundation

public struct StageBJoinParameters {
    public enum Provider: Equatable {
        case wbstream
        case telemost
    }

    public let provider: Provider
    private let joinLink: String

    public init?(joinLink: String) {
        // Absolute anchors deliberately reject trailing newlines and all URL extras.
        if joinLink.range(of: #"\Awbstream://[A-Za-z0-9_-]{6,160}\z"#,
                          options: .regularExpression) != nil {
            provider = .wbstream
        } else if joinLink.range(of: #"\Ahttps://telemost\.yandex\.ru/j/[0-9]{1,160}\z"#,
                                 options: .regularExpression) != nil {
            provider = .telemost
        } else {
            return nil
        }
        self.joinLink = joinLink
    }

    public func encoded() throws -> String {
        var params: [String: Any] = [
            "displayName": "INVIZENT",
            "vp8Fps": 0,
            "vp8Batch": 0,
            "dualTrack": false,
            "reliable": true
        ]
        switch provider {
        case .wbstream:
            params["roomId"] = String(joinLink.dropFirst("wbstream://".count))
            params["tunnelMode"] = "dc"
        case .telemost:
            // The pinned Telemost joiner uses VP8 and expects the complete URI.
            // Zero FPS/batch selects upstream defaults; this is not a DC tunnel.
            params["joinLink"] = joinLink
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: params), as: UTF8.self)
    }
}
