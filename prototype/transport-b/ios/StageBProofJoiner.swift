// Stage B bridge shared by the standalone proof and opt-in Expo module.
// A local SOCKS endpoint alone DOES NOT route the app's requests or prove connectivity.
import Foundation
import CFNetwork
import Darwin
import Mobile

public enum StageBProofError: Error {
    case invalidJoinLink
    case invalidSocksPort
    case invalidParameters
}

// Gomobile invokes these methods on background threads. This callback does not
// copy upstream diagnostics into application logs: they may contain bearer URLs.
public final class StageBProofCallback: NSObject, IosHeadlessCallbackProtocol {
    private let cacheLock = NSLock()
    private var cache: [String: String] = [:]
    public var statusHandler: ((String) -> Void)?

    public func onLog(_ msg: String?) {
        // No logging of room links, session credentials or third-party tokens.
    }

    public func onStatus(_ status: String?) {
        guard let status else { return }
        statusHandler?(status)
    }

    public func saveCache(_ key: String?, value: String?) {
        guard let key, let value, key.count <= 256, value.count <= 8192 else { return }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        cache[key] = value
    }

    public func loadCache(_ key: String?) -> String {
        guard let key else { return "" }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        return cache[key] ?? ""
    }

    public func clearCache(_ key: String?) {
        guard let key else { return }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        cache.removeValue(forKey: key)
    }

    public func resolveHost(_ hostname: String?) -> String {
        guard let hostname, !hostname.isEmpty, hostname.count <= 253 else { return "" }
        let host = CFHostCreateWithName(nil, hostname as CFString).takeRetainedValue()
        guard CFHostStartInfoResolution(host, .addresses, nil),
              let addresses = CFHostGetAddressing(host, nil)?.takeUnretainedValue() as? [Data] else {
            return ""
        }
        for addressData in addresses {
            var addr = sockaddr_in()
            addressData.withUnsafeBytes { bytes in
                if let base = bytes.baseAddress, addressData.count >= MemoryLayout<sockaddr_in>.size {
                    memcpy(&addr, base, MemoryLayout<sockaddr_in>.size)
                }
            }
            if addr.sin_family == sa_family_t(AF_INET) {
                var address = addr.sin_addr
                var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                guard inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else { continue }
                return String(cString: buffer)
            }
        }
        return ""
    }
}

// Native proof only. start() begins an async WebRTC negotiation but does NOT
// signal connection success. The eventual app adapter must wait for a verified
// native connected status and set up an app-scoped, authenticated network client.
public final class StageBProofJoiner {
    public let callback = StageBProofCallback()

    public init() {}

    private func availablePort() throws -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw StageBProofError.invalidSocksPort }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, length) }
        }
        guard bound == 0 else { throw StageBProofError.invalidSocksPort }
        let result = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
        }
        guard result == 0 else { throw StageBProofError.invalidSocksPort }
        // Go owns the listener. A competing bind after close fails route validation;
        // per-session SOCKS authentication prevents using a substituted listener.
        return Int(UInt16(bigEndian: address.sin_port))
    }

    @discardableResult
    public func start(joinLink: String, socksPort: Int = 0) throws -> (port: UInt16, username: String, password: String) {
        guard let parameters = StageBJoinParameters(joinLink: joinLink) else {
            throw StageBProofError.invalidJoinLink
        }
        guard socksPort >= 0 && socksPort <= 65535 else {
            throw StageBProofError.invalidSocksPort
        }
        // Credentials are generated per session. Do not expose the local SOCKS
        // listener without authentication or use it as a general-purpose proxy.
        let socksUser = "invizent-" + UUID().uuidString
        let socksPass = UUID().uuidString + UUID().uuidString
        guard let json = try? parameters.encoded() else {
            throw StageBProofError.invalidParameters
        }
        let port = try socksPort == 0 ? availablePort() : socksPort
        switch parameters.provider {
        case .wbstream:
            IosStartWBStreamHeadless(port, socksUser, socksPass, callback)
        case .telemost:
            IosStartTelemostHeadless(port, socksUser, socksPass, callback)
        }
        IosSendJoinParams(json)
        return (UInt16(port), socksUser, socksPass)
    }

    public func stop() {
        IosStopHeadless()
    }
}
