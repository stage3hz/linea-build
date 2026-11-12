import Foundation
import Security

/// The key this device's sessions are bound to (server: devicebind.js): ECDSA P-256, created in the Secure Enclave,
/// which never gives the private key out — a copy of the app's files or of its session token cannot sign with it.
/// Where there is no enclave (the simulator) the key lives in the Keychain of this device only.
/// It is not tied to Face ID or the passcode: it has to sign while the app refreshes in the background.
enum DeviceKey {
  struct Failure: Error { let reason: String }

  private static let tag = Data("com.invizent.device-key.v1".utf8)
  private static let lock = NSLock()

  private static func find() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let found = item else { return nil }
    guard CFGetTypeID(found) == SecKeyGetTypeID() else { return nil }
    return (found as! SecKey)
  }

  private static func create(inEnclave: Bool) -> SecKey? {
    var privateAttributes: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
    ]
    if inEnclave {
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, nil) else { return nil }
      privateAttributes[kSecAttrAccessControl as String] = access
    } else {
      privateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttributes,
    ]
    if inEnclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
    var error: Unmanaged<CFError>?
    let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
    error?.release()
    return key
  }

  private static func inEnclave(_ key: SecKey) -> Bool {
    guard let attributes = SecKeyCopyAttributes(key) as? [String: Any], let token = attributes[kSecAttrTokenID as String] as? String else { return false }
    return token == (kSecAttrTokenIDSecureEnclave as String)
  }

  private static func key() throws -> SecKey {
    lock.lock(); defer { lock.unlock() }
    if let existing = find() { return existing }
    if let created = create(inEnclave: true) ?? create(inEnclave: false) { return created }
    throw Failure(reason: "DEVICE_KEY_UNAVAILABLE")
  }

  private static func base64url(_ data: Data) -> String {
    return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// The public key as the server takes it: base64url of the 65-byte point 04 ‖ X ‖ Y.
  static func ensure() throws -> [String: String] {
    let privateKey = try key()
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw Failure(reason: "DEVICE_KEY_UNAVAILABLE") }
    var error: Unmanaged<CFError>?
    guard let point = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?, point.count == 65 else {
      error?.release()
      throw Failure(reason: "DEVICE_KEY_UNAVAILABLE")
    }
    return ["publicKey": base64url(point), "kind": inEnclave(privateKey) ? "hardware" : "software"]
  }

  /// ECDSA over SHA-256 of the message's UTF-8 bytes, DER-encoded, base64url.
  static func sign(_ message: String) throws -> String {
    let privateKey = try key()
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else {
      error?.release()
      throw Failure(reason: "DEVICE_KEY_SIGN_FAILED")
    }
    return base64url(signature)
  }
}
