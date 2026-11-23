import CryptoKit
import Foundation
import SQLCipher

/// The private storage of one account on this device: an SQLCipher database whose key lives in the keychain.
/// Everything the encryption needs is here — the Signal state, who is trusted, decrypted messages.
///
/// The file, its table and the key's name are those of the previous app, so an update opens the storage that
/// is already on the phone. A lost or damaged key never silently makes a new identity: opening fails and the
/// database stays as it was.
final class Vault {
    enum Failure: Error {
        /// The build has no SQLCipher: keys are never kept unencrypted.
        case noCipher
        case badKey
        /// The database could not be opened with the key; nothing was changed.
        case cannotOpen
        case closed
        case write
    }

    private var db: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    /// The SQLite result code of the last statement that failed (for `lastFailure`).
    private var lastCode: Int32 = 0

    /// Which step of the last opening failed, in a few words — never the key, the path or anything stored: the
    /// keychain's status, SQLite's result code, whether the file was there and its size. Empty after an opening that
    /// went well. Only read for a log line (App/SceneDelegate.swift) and the read-only report (TakeoverCheck.swift);
    /// the errors thrown stay as they are.
    private(set) static var lastFailure = ""
    /// A step before the storage that kept the account from opening (non-secret words for the device's log).
    static func note(_ words: String) { lastFailure = words }

    /// `server\0user` hashed: what the files and the key of one account on one server are named by.
    static func scope(server: String, userId: String) -> String {
        SHA256.hash(data: Data("\(server)\u{0}\(userId)".utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The keychain's answer for `lastFailure`: its status code only.
    private static func keychainWords(_ what: String, _ error: Error) -> String {
        if let failure = error as? KeychainError { return "keychain \(what) status \(failure.status)" }
        return "keychain \(what) failed (\(type(of: error)))"
    }

    /// Reads the storage's key from the keychain, noting a failure.
    private static func readKey(_ scope: String) throws -> String? {
        do {
            return try Keychain.get("linea.e2ee.v1.\(scope)")
        } catch {
            lastFailure = keychainWords("read", error)
            throw error
        }
    }

    /// Opens the account's storage, making it on the first sign-in. `earlierServers`: addresses the same server
    /// was known by before — a storage made under one of them is reused.
    init(server: String, userId: String, earlierServers: [String] = []) throws {
        Vault.lastFailure = ""
        var scope = Vault.scope(server: server, userId: userId)
        var key = try Vault.readKey(scope)
        if key == nil {
            for earlier in earlierServers where earlier != server {
                let candidate = Vault.scope(server: earlier, userId: userId)
                if let found = try Vault.readKey(candidate) { scope = candidate; key = found; break }
            }
        }
        let folder: URL
        do {
            folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("SQLite", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            let reason = error as NSError
            Vault.lastFailure = "storage folder: \(reason.domain) \(reason.code)"
            throw error
        }
        let path = folder.appendingPathComponent("linea-e2ee-\(scope).db").path
        // Whether the file was there before opening (opening makes it), and how big: says a lost key from a new account.
        let bytesBefore = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber
        let file = bytesBefore.map { "file exists, \($0.intValue) bytes" } ?? "no file before opening"
        let keyFrom = key == nil ? "no key in the keychain" : "key from the keychain"
        let opened = sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard opened == SQLITE_OK else {
            Vault.lastFailure = "open rc \(opened) (\(file))"
            close()
            throw Failure.cannotOpen
        }
        var step = "cipher_version"
        do {
            guard let cipher = try text("PRAGMA cipher_version"), !cipher.isEmpty else {
                Vault.lastFailure = "cipher missing (the build has no SQLCipher)"
                throw Failure.noCipher
            }
            if let key {
                guard key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                    Vault.lastFailure = "keychain key malformed (\(key.count) characters, 64 hex expected)"
                    throw Failure.badKey
                }
                step = "key pragma"
                try run("PRAGMA key = \"x'\(key)'\";")
            } else {
                var bytes = [UInt8](repeating: 0, count: 32)
                let random = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
                guard random == errSecSuccess else {
                    Vault.lastFailure = "random key status \(random)"
                    throw Failure.cannotOpen
                }
                let fresh = bytes.map { String(format: "%02x", $0) }.joined()
                // If an encrypted database is already there and its key is lost, the read below fails and the
                // database is left intact instead of being written over.
                step = "new key pragma"
                try run("PRAGMA key = \"x'\(fresh)'\";")
                step = "first read"
                _ = try text("SELECT count(*) FROM sqlite_master")
                do {
                    try Keychain.set("linea.e2ee.v1.\(scope)", fresh)
                } catch {
                    Vault.lastFailure = Vault.keychainWords("write", error)
                    throw error
                }
            }
            step = "setup"
            try run("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS private_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        } catch let failure as Failure {
            if Vault.lastFailure.isEmpty {
                // With a key from the keychain the setup is the first statement that reads the file: SQLITE_NOTADB
                // (26) there means the key does not open this file.
                let rejected = step == "setup" && key != nil && lastCode & 0xFF == 26 ? "key rejected, " : ""
                Vault.lastFailure = "\(rejected)\(step) rc \(lastCode) (\(keyFrom), \(file))"
            }
            close()
            throw failure == .noCipher || failure == .badKey ? failure : Failure.cannotOpen
        } catch {
            if Vault.lastFailure.isEmpty { Vault.lastFailure = "\(step): \(type(of: error)) (\(keyFrom), \(file))" }
            close()
            throw Failure.cannotOpen
        }
    }

    deinit { close() }

    func close() {
        if let db { sqlite3_close_v2(db) }
        db = nil
    }

    private func run(_ sql: String) throws {
        guard let db else { throw Failure.closed }
        let code = sqlite3_exec(db, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            lastCode = sqlite3_extended_errcode(db)
            throw Failure.write
        }
    }

    /// The first column of the first row of a query, as text.
    private func text(_ sql: String, _ arguments: [String] = []) throws -> String? {
        guard let db else { throw Failure.closed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            lastCode = sqlite3_extended_errcode(db)
            throw Failure.write
        }
        defer { sqlite3_finalize(statement) }
        for (index, argument) in arguments.enumerated() { sqlite3_bind_text(statement, Int32(index + 1), argument, -1, transient) }
        let stepped = sqlite3_step(statement)
        switch stepped {
        case SQLITE_ROW: return sqlite3_column_text(statement, 0).map { String(cString: $0) }
        case SQLITE_DONE: return nil
        default:
            lastCode = sqlite3_extended_errcode(db)
            throw Failure.write
        }
    }

    func get(_ name: String) throws -> String? {
        try text("SELECT value FROM private_values WHERE key = ?", [name])
    }

    /// Writes every change or none. A nil value removes the record.
    func commit(_ changes: [(String, String?)]) throws {
        try run("BEGIN IMMEDIATE")
        do {
            for (name, value) in changes {
                if let value { _ = try text("INSERT INTO private_values (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [name, value]) }
                else { _ = try text("DELETE FROM private_values WHERE key = ?", [name]) }
            }
            try run("COMMIT")
        } catch {
            try? run("ROLLBACK")
            throw error
        }
    }
}

#if targetEnvironment(simulator)
extension Vault {
    /// For the update check (TakeoverCheck.swift): the records whose names start with `prefix` — how many, and the
    /// values of up to `limit` of them. Read only.
    func records(prefix: String, limit: Int) throws -> (count: Int, values: [String]) {
        guard let db else { throw Failure.closed }
        let pattern = prefix.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "%"
        let count = Int(try text("SELECT count(*) FROM private_values WHERE key LIKE ? ESCAPE '\\'", [pattern]) ?? "0") ?? 0
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM private_values WHERE key LIKE ? ESCAPE '\\' LIMIT ?", -1, &statement, nil) == SQLITE_OK else { throw Failure.write }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, pattern, -1, transient)
        sqlite3_bind_int(statement, 2, Int32(limit))
        var values: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let value = sqlite3_column_text(statement, 0) { values.append(String(cString: value)) }
        }
        return (count, values)
    }

    func cipherVersion() -> String {
        guard let version = try? text("PRAGMA cipher_version") else { return "?" }
        return version
    }

    /// For the simulator check: makes a storage for a made-up account, writes, closes, opens again and reads.
    /// Says what happened in a line.
    static func selfCheck() -> String {
        let user = "00000000-0000-4000-8000-00000000c0de", server = "https://localhost:8443"
        do {
            let stamp = String(Int(Date().timeIntervalSince1970))
            let first = try Vault(server: server, userId: user)
            let cipher = try first.text("PRAGMA cipher_version") ?? "?"
            try first.commit([("check:a", stamp), ("check:b", "удалить")])
            try first.commit([("check:b", nil)])
            first.close()
            let second = try Vault(server: server, userId: user)
            let back = try second.get("check:a"), gone = try second.get("check:b")
            second.close()
            // The file itself must not be readable without the key.
            let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: false).appendingPathComponent("SQLite")
            let file = folder.appendingPathComponent("linea-e2ee-\(scope(server: server, userId: user)).db")
            let head = (try? Data(contentsOf: file).prefix(15)) ?? Data()
            let plain = String(data: head, encoding: .utf8) == "SQLite format 3"
            return back == stamp && gone == nil && !plain ? "хранилище: записано, закрыто, открыто, прочитано · SQLCipher \(cipher)" : "хранилище: НЕ СОШЛОСЬ (прочитано \(back ?? "ничего"), открытый файл: \(plain))"
        } catch {
            return "хранилище: ошибка \(error)"
        }
    }
}
#endif
