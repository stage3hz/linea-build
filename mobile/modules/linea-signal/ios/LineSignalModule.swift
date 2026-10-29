import ExpoModulesCore

private struct LineaSignalError: CodedError {
  let code: String
  let description: String
}

public final class LineSignalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LineaSignal")
    Constants(["libsignalVersion": SignalCore.version])
    AsyncFunction("createState") { (name: String, deviceId: Int) in try self.protect { try SignalCore.createState(name, deviceId) } }
    AsyncFunction("replenish") { (state: String, count: Int) in try self.protect { try SignalCore.replenish(state, count) } }
    AsyncFunction("trustIdentity") { (state: String, name: String, deviceId: Int, identity: String) in try self.protect { try SignalCore.trustIdentity(state, name, deviceId, identity) } }
    AsyncFunction("encrypt") { (state: String, name: String, deviceId: Int, plaintext: String, bundle: [String: Any]?) in try self.protect { try SignalCore.encrypt(state, name, deviceId, plaintext, bundle) } }
    AsyncFunction("decrypt") { (state: String, name: String, deviceId: Int, type: Int, body: String) in try self.protect { try SignalCore.decrypt(state, name, deviceId, type, body) } }
    AsyncFunction("seal") { (plaintext: String, key: String, nonce: String, ad: String) in try self.protect { try SignalCore.seal(plaintext, key, nonce, ad) } }
    AsyncFunction("open") { (ciphertext: String, key: String, nonce: String, ad: String) in try self.protect { try SignalCore.open(ciphertext, key, nonce, ad) } }
  }
  private func protect<T>(_ body: () throws -> T) throws -> T {
    do { return try body() }
    catch {
      let reason = (error as? SignalBridgeFailure)?.reason ?? "CRYPTO_FAILED"
      throw LineaSignalError(code: "ERR_LINEA_SIGNAL_\(reason)", description: "Signal operation rejected: \(reason)")
    }
  }
}
