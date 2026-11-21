import Foundation

/// Why an operation of the encryption service did not give its answer: the kind (`UntrustedDeviceError`,
/// `NetworkError`, `PartialSync`, `Error`) and the words for the person.
struct CryptoFailure: Error {
    let name: String
    let message: String
}

/// The signed-in person's end-to-end encryption on this device.
///
/// All the logic — keys, trust, what is sent to whom, what is remembered — is the shared core's; this class
/// gives it the private storage and the server and runs it on one queue of its own, one operation at a time.
/// Nothing decrypted leaves the device, and nothing here is written to logs.
final class CryptoService {
    private let vault: Vault
    private let server: Server
    private let queue = DispatchQueue(label: "invizent.crypto", qos: .userInitiated)
    private var handle: OpaquePointer?
    private var host = InvizentHost()

    init(userId: String, vault: Vault, server: Server) {
        self.vault = vault
        self.server = server
        host.context = Unmanaged.passUnretained(self).toOpaque()
        host.bridge = nil
        host.vault_get = { context, key in
            guard let context, let key else { return nil }
            let service = Unmanaged<CryptoService>.fromOpaque(context).takeUnretainedValue()
            guard let value = try? service.vault.get(String(cString: key)) else { return nil }
            return strdup(value)
        }
        host.vault_commit = { context, changes in
            guard let context, let changes else { return }
            let service = Unmanaged<CryptoService>.fromOpaque(context).takeUnretainedValue()
            guard let list = Core.value(String(cString: changes)) as? [[Any]] else { return }
            let pairs: [(String, String?)] = list.compactMap { pair in
                guard pair.count == 2, let key = pair[0] as? String else { return nil }
                return (key, pair[1] as? String)
            }
            // A storage that cannot be written is not something to carry on from: keys and ratchets would be lost.
            do { try service.vault.commit(pairs) } catch { fatalError("The private storage could not be written.") }
        }
        host.transport = { context, method, args in
            guard let context, let method, let args else { return nil }
            let service = Unmanaged<CryptoService>.fromOpaque(context).takeUnretainedValue()
            // The core's `cryptoInbox` is the server's inbox page.
            let name = String(cString: method)
            let list = Core.value(String(cString: args)) as? [Any] ?? []
            let answer: [String: Any]
            switch service.server.opAndWait(name == "cryptoInbox" ? "inboxPage" : name, list) {
            case .success(let body): answer = ["ok": body]
            case .failure(.refused(let message, _, _, _)): answer = ["refused": message]
            case .failure(let error): answer = ["network": error.words]
            }
            return Core.text(answer).flatMap { strdup($0) }
        }
        host.now_iso = nil
        host.random_uuid = nil
        handle = userId.withCString { invizent_crypto_new($0, true, &host) }
    }

    deinit { invizent_crypto_free(handle) }

    /// Runs one operation (names and arguments: the core's `e2ee::dispatch`); the answer comes on the main queue.
    func call(_ op: String, _ args: [Any] = [], done: @escaping (Result<Any, CryptoFailure>) -> Void) {
        queue.async { [self] in
            let result = callNow(op, args)
            DispatchQueue.main.async { done(result) }
        }
    }

    /// The same on the service's own queue, for work that chains several operations. Never call on the main queue.
    func run<T>(_ work: @escaping (CryptoService) -> T, done: @escaping (T) -> Void) {
        queue.async { [self] in
            let result = work(self)
            DispatchQueue.main.async { done(result) }
        }
    }

    /// Offline: what the core's `loadCache` gives (the vault's copy of the chat list or of a chat's page), read at
    /// once on the caller's queue (never the main one) instead of waiting behind network work on the service's
    /// queue. Only the names the core accepts; the storage is opened for use from several threads.
    func loadCacheAtOnce(_ name: String) -> String? {
        guard ChatCache.isCacheName(name) else { return nil }
        return try? vault.get(name)
    }

    /// One operation, on the current (the service's) queue.
    func callNow(_ op: String, _ args: [Any] = []) -> Result<Any, CryptoFailure> {
        guard let handle, let argsText = Core.text(args) else { return .failure(CryptoFailure(name: "Error", message: "Шифрование недоступно.")) }
        let raw: UnsafeMutablePointer<CChar>? = op.withCString { op in argsText.withCString { invizent_crypto_call(handle, op, $0) } }
        guard let raw else { return .failure(CryptoFailure(name: "Error", message: "Шифрование недоступно.")) }
        defer { invizent_string_free(raw) }
        guard let answer = Core.value(String(cString: raw)) as? [String: Any] else { return .failure(CryptoFailure(name: "Error", message: "Шифрование недоступно.")) }
        if let error = answer["error"] as? [String: Any] { return .failure(CryptoFailure(name: error["name"] as? String ?? "Error", message: error["message"] as? String ?? "")) }
        return .success(answer["ok"] ?? NSNull())
    }
}
