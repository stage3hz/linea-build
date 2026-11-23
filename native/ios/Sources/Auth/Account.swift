import UIKit

/// Where the app connects, and the session kept on this device.
enum Account {
    /// The server. A simulator build may be pointed at a local test server (`-server https://localhost:8443`).
    static var server: String {
        #if targetEnvironment(simulator)
        if let test = UserDefaults.standard.string(forKey: "server"), test.hasPrefix("https://localhost:") { return test }
        #endif
        return "https://api.invizent.com"
    }

    static let tokenName = "linea.session.v1"

    /// The session's token: in the keychain, under the name the previous app used, so an update stays signed in.
    static var token: String? {
        get { try? Keychain.get(tokenName) }
        set { if let newValue { try? Keychain.set(tokenName, newValue) } else { Keychain.remove(tokenName) } }
    }

    /// What the server is told about this device at sign-in (shown in «Активные сеансы»): its kind and system,
    /// nothing that locates or identifies it.
    static var deviceFields: [String: Any] {
        let model: String
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: model = "iPad"
        case .mac: model = "Mac"
        default: model = "iPhone"
        }
        return ["deviceName": model, "platform": "ios", "deviceModel": model, "osVersion": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
                "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"]
    }

    /// The profile inside what is kept. The previous app kept the server's whole answer — `{user, securitySetupRequired}`
    /// (mobile/App.tsx:129, 133, 146) — and that record is taken over as it is (Storage/OldAppSettings.swift), so the
    /// profile may lie one level down. Without an id it is no profile: the app then asks the server instead.
    static func profile(of kept: [String: Any]?) -> [String: Any]? {
        guard let kept else { return nil }
        if kept["id"] is String { return kept }
        if let inner = kept["user"] as? [String: Any], inner["id"] is String { return inner }
        return nil
    }

    /// The account's public profile as the server last gave it: lets the app open without waiting for the network.
    static var cachedUser: [String: Any]? {
        get { Account.profile(of: (UserDefaults.standard.string(forKey: "invizent.session-user.v1")).flatMap { Core.value($0) as? [String: Any] }) }
        set { UserDefaults.standard.set(newValue.flatMap { Core.text($0) }, forKey: "invizent.session-user.v1") }
    }
}
