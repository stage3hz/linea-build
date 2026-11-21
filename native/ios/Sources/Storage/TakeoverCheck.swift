#if targetEnvironment(simulator)
import CryptoKit
import UIKit

/// The update check of the simulator (.github/workflows/native-takeover.yml): this app installed OVER the previous
/// one with the same identifier must find what that app left on the phone — the session, the device key, the
/// storage key, the encrypted storage and the decrypted history in it.
///
///   -takeovercheck 1 -takeoveruser <account id> [-takeoverexpect "text|text"] [-server https://localhost:…]
///
/// Read only: nothing is made, written or sent (a storage whose key is missing is not opened, so no new key is made).
/// No secret is shown — only whether each thing is there, sizes and short hashes. The report is shown on the screen
/// and written to Documents/takeover-check.txt for the workflow to read.
enum TakeoverCheck {
    private static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    private static func json(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private static func keychain(_ name: String) -> (String?, String) {
        do {
            guard let value = try Keychain.get(name) else { return (nil, "missing") }
            return (value, "present (\(value.utf8.count) bytes)")
        } catch let error as KeychainError {
            return (nil, "ERROR status \(error.status)")
        } catch {
            return (nil, "ERROR \(error)")
        }
    }

    static func run() -> String {
        let args = UserDefaults.standard
        let server = Account.server
        let user = args.string(forKey: "takeoveruser") ?? ""
        let expected = (args.string(forKey: "takeoverexpect") ?? "").split(separator: "|").map(String.init).filter { !$0.isEmpty }
        var lines = ["takeover-check v1", "server=\(server)", "user=\(user)"]
        var ok = true
        func need(_ condition: Bool) { if !condition { ok = false } }

        let (token, tokenLine) = keychain(Account.tokenName)
        lines.append("token[\(Account.tokenName)]=\(tokenLine)")
        need(token != nil)
        lines.append("passcode[linea.passcode.v1]=\(keychain("linea.passcode.v1").1)")
        lines.append("recovery[linea.recovery.pending.v1]=\(keychain("linea.recovery.pending.v1").1)")
        if let key = DeviceKey.existingPublicKey() { lines.append("devicekey=present (public \(hash(key)))") } else { lines.append("devicekey=missing"); need(false) }

        guard user.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) != nil else {
            lines.append("ERROR: -takeoveruser <account id> was not given")
            lines.append("VERDICT=FAIL")
            return lines.joined(separator: "\n")
        }
        let scope = Vault.scope(server: server, userId: user)
        lines.append("scope=\(scope)")
        let (vaultKey, vaultKeyLine) = keychain("linea.e2ee.v1.\(scope)")
        lines.append("vaultkey[linea.e2ee.v1.<scope>]=\(vaultKeyLine)" + (vaultKey.map { $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil ? ", 64 hex" : ", NOT 64 hex" } ?? ""))
        need(vaultKey?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)

        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = documents.appendingPathComponent("SQLite/linea-e2ee-\(scope).db")
        if let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber {
            let head = (try? Data(contentsOf: file).prefix(16)) ?? Data()
            let plain = String(data: head.prefix(15), encoding: .utf8) == "SQLite format 3"
            lines.append("vaultfile[Documents/SQLite/linea-e2ee-<scope>.db]=present (\(size.intValue) bytes, header \(plain ? "PLAIN SQLite" : "encrypted"))")
            need(!plain)
        } else {
            lines.append("vaultfile[Documents/SQLite/linea-e2ee-<scope>.db]=missing")
            need(false)
        }
        let others = (try? FileManager.default.contentsOfDirectory(atPath: documents.appendingPathComponent("SQLite").path)) ?? []
        lines.append("sqlite-folder=\(others.sorted().map { $0.replacingOccurrences(of: scope, with: "<scope>") }.joined(separator: ", "))")

        guard vaultKey != nil else {
            lines.append("vaultopen=skipped (no key: opening would make a new one)")
            lines.append("VERDICT=FAIL")
            return lines.joined(separator: "\n")
        }
        do {
            let vault = try Vault(server: server, userId: user)
            defer { vault.close() }
            lines.append("vaultopen=ok (SQLCipher \(vault.cipherVersion()))")
            let device = try vault.get("device")
            lines.append("device=" + (device.map { "present (sha256 \(hash($0)))" } ?? "missing"))
            need(device != nil)
            let protocolState = try vault.get("protocol")
            lines.append("protocol=" + (protocolState.map { "present (\($0.utf8.count) bytes)" } ?? "missing"))
            need(protocolState != nil)
            let messages = try vault.records(prefix: "message:", limit: 2000)
            var texts: [String] = []
            var failed = 0
            for raw in messages.values {
                guard let record = json(raw) as? [String: Any] else { continue }
                if record["failed"] as? Bool == true { failed += 1; continue }
                if let plain = record["plain"] as? [String: Any], let text = plain["text"] as? String { texts.append(text) }
            }
            lines.append("messages[message:*]=\(messages.count) (decrypted with text: \(texts.filter { !$0.isEmpty }.count), could not be opened: \(failed))")
            need(!texts.filter { !$0.isEmpty }.isEmpty)
            for (label, prefix) in [("history", "history:"), ("sessions", "session:"), ("trust", "trust:"), ("devices", "devices:")] {
                let found = try vault.records(prefix: prefix, limit: 0)
                lines.append("\(label)[\(prefix)*]=\(found.count)")
            }
            let list = (try vault.get("chats:v1")).flatMap { json($0) as? [Any] }
            lines.append("chats-cache[chats:v1]=" + (list.map { "\($0.count) chats" } ?? "missing"))
            let pages = try vault.records(prefix: "page:v1:", limit: 200)
            lines.append("pages-cache[page:v1:*]=\(pages.count)")
            lines.append("saved[saved:v1]=" + ((try vault.get("saved:v1")) != nil ? "present" : "missing"))
            for text in expected {
                let inHistory = texts.contains(text)
                let inPages = pages.values.contains { $0.contains(text) }
                lines.append("expect \"\(text)\"=" + (inHistory ? "found in the decrypted messages" : inPages ? "found in the page cache only" : "MISSING"))
                need(inHistory)
            }
        } catch {
            lines.append("vaultopen=FAILED (\(error))")
            need(false)
        }
        lines.append("VERDICT=\(ok ? "PASS" : "FAIL")")
        return lines.joined(separator: "\n")
    }
}

/// Shows the report of TakeoverCheck and writes it to Documents/takeover-check.txt.
final class TakeoverCheckViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let report = TakeoverCheck.run()
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let name = UserDefaults.standard.string(forKey: "takeoverreport") ?? "takeover-check.txt"
        try? (report + "\n").write(to: documents.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_")), atomically: true, encoding: .utf8)
        let text = UITextView()
        text.text = report
        text.isEditable = false
        text.backgroundColor = .black
        text.textColor = report.hasSuffix("VERDICT=PASS") ? UIColor(red: 0.5, green: 1, blue: 0.6, alpha: 1) : UIColor(red: 1, green: 0.55, blue: 0.5, alpha: 1)
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        text.accessibilityIdentifier = "takeover-report"
        text.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(text)
        NSLayoutConstraint.activate([
            text.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            text.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            text.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            text.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
        ])
    }
}
#endif
