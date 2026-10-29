import Foundation
import LibSignalClient

struct SignalBridgeFailure: Error { let reason: String }

/// Each call loads an isolated in-memory store. The caller commits the returned
/// state and message atomically in its encrypted database. This module neither
/// persists nor logs state, plaintext, file contents, or key material.
enum SignalCore {
  static let version = "0.106.0"
  static let maxState = 16 * 1024 * 1024
  static let maxMessage = 1024 * 1024
  static let maxFile = 20 * 1024 * 1024
  static let maxPreKeys = 1000
  static let context = NullContext()

  static func require(_ condition: Bool, _ reason: String) throws {
    if !condition { throw SignalBridgeFailure(reason: reason) }
  }
  static func address(_ name: String, _ deviceId: Int) throws -> ProtocolAddress {
    try require(deviceId == 1 && name.range(of: "^[A-Za-z0-9._:-]{1,160}$", options: .regularExpression) != nil, "INVALID_ADDRESS")
    return try ProtocolAddress(name: name, deviceId: UInt32(deviceId))
  }
  static func decode(_ value: String, limit: Int) throws -> Data {
    try require(value.utf8.count <= ((limit + 2) / 3) * 4 && value.utf8.count % 4 == 0, "INVALID_BASE64")
    guard let data = Data(base64Encoded: value), data.count <= limit, data.base64EncodedString() == value else { throw SignalBridgeFailure(reason: "INVALID_BASE64") }
    return data
  }
  static func string(_ object: [String: Any], _ key: String) throws -> String {
    guard let value = object[key] as? String else { throw SignalBridgeFailure(reason: "INVALID_FIELD") }
    return value
  }
  static func integer(_ object: [String: Any], _ key: String, max: Int = Int(Int32.max)) throws -> UInt32 {
    guard let value = object[key] as? NSNumber else { throw SignalBridgeFailure(reason: "INVALID_NUMBER") }
    let number = value.doubleValue
    try require(number.isFinite && number >= 1 && number <= Double(max) && number.rounded() == number, "INVALID_NUMBER")
    return UInt32(number)
  }
  static func object(_ value: [String: Any], _ key: String) throws -> [String: Any] {
    guard let result = value[key] as? [String: Any] else { throw SignalBridgeFailure(reason: "INVALID_FIELD") }
    return result
  }

  static func createState(_ localAddressName: String, _ deviceId: Int) throws -> [String: Any] {
    _ = try address(localAddressName, deviceId)
    let identity = IdentityKeyPair.generate()
    // Same OS-backed generator used by the official Swift in-memory store;
    // registrationId is a public protocol identifier, not private key material.
    let registration = UInt32.random(in: 1...16380)
    let state = PersistentSignalState(localAddressName: localAddressName, localDeviceId: deviceId,
      identityKeyPair: identity.serialize().base64EncodedString(), registrationId: registration)
    let store = try SignalStateStore(state)
    let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
    let signedKey = PrivateKey.generate()
    let signed = try SignedPreKeyRecord(id: 1, timestamp: timestamp, privateKey: signedKey,
      signature: identity.privateKey.generateSignature(message: signedKey.publicKey.serialize()))
    try store.storeSignedPreKey(signed, id: 1, context: context)
    let kyberKey = KEMKeyPair.generate()
    let kyber = try KyberPreKeyRecord(id: 1, timestamp: timestamp, keyPair: kyberKey,
      signature: identity.privateKey.generateSignature(message: kyberKey.publicKey.serialize()))
    try store.storeKyberPreKey(kyber, id: 1, context: context)
    return try generated(store, count: 20)
  }
  static func replenish(_ state: String, _ count: Int) throws -> [String: Any] {
    return try generated(SignalStateStore.parse(state), count: count)
  }
  private static func generated(_ store: SignalStateStore, count: Int) throws -> [String: Any] {
    try require((1...100).contains(count), "INVALID_PREKEY_COUNT")
    try require(store.state.preKeys.count + count <= maxPreKeys, "PREKEY_CAPACITY")
    let first = store.state.nextPreKeyId
    try require(first >= 1 && first <= UInt32(Int32.max) - UInt32(count), "PREKEY_ID_EXHAUSTED")
    var fresh: [[String: Any]] = []
    for id in first..<(first + UInt32(count)) {
      let record = try PreKeyRecord(id: id, privateKey: PrivateKey.generate())
      try store.storePreKey(record, id: id, context: context)
      fresh.append(["id": id, "publicKey": try record.publicKey().serialize().base64EncodedString()])
    }
    store.state.nextPreKeyId = first + UInt32(count)
    return ["state": try store.export(), "bundle": try publicBundle(store, fresh)]
  }
  private static func publicBundle(_ store: SignalStateStore, _ fresh: [[String: Any]]) throws -> [String: Any] {
    let signed = try store.loadSignedPreKey(id: store.state.signedPreKeyId, context: context)
    let kyber = try store.loadKyberPreKey(id: store.state.kyberPreKeyId, context: context)
    return [
      "registrationId": store.state.registrationId,
      "identityKey": store.identityPair.identityKey.serialize().base64EncodedString(),
      "signedPreKey": ["id": signed.id, "publicKey": try signed.publicKey().serialize().base64EncodedString(), "signature": signed.signature.base64EncodedString()],
      "kyberPreKey": ["id": kyber.id, "publicKey": try kyber.publicKey().serialize().base64EncodedString(), "signature": kyber.signature.base64EncodedString()],
      "preKeys": fresh
    ]
  }
  static func trustIdentity(_ state: String, _ name: String, _ deviceId: Int, _ publicKey: String) throws -> [String: Any] {
    let store = try SignalStateStore.parse(state)
    let data = try decode(publicKey, limit: 33)
    try require(data.count == 33, "INVALID_IDENTITY")
    try store.pin(IdentityKey(bytes: data), address: address(name, deviceId))
    return ["state": try store.export()]
  }
  static func encrypt(_ state: String, _ name: String, _ deviceId: Int, _ plaintext: String, _ bundle: [String: Any]?) throws -> [String: Any] {
    let store = try SignalStateStore.parse(state)
    let remote = try address(name, deviceId)
    try require(try store.identity(for: remote, context: context) != nil, "TRUST_REQUIRED")
    let bytes = Data(plaintext.utf8)
    try require(bytes.count <= maxMessage, "MESSAGE_TOO_LARGE")
    if let bundle = bundle {
      let preKeys = try remoteBundle(bundle, deviceId)
      try require(try store.isTrustedIdentity(preKeys.identityKey, for: remote, direction: .sending, context: context), "IDENTITY_CHANGED")
      if try store.loadSession(for: remote, context: context)?.hasCurrentState != true {
        try processPreKeyBundle(preKeys, for: remote, ourAddress: store.localAddress, sessionStore: store, identityStore: store, context: context)
      }
    }
    let cipher = try signalEncrypt(message: bytes, for: remote, localAddress: store.localAddress, sessionStore: store, identityStore: store, context: context)
    let type = Int(cipher.messageType.rawValue)
    try require(type == 2 || type == 3, "UNSUPPORTED_MESSAGE_TYPE")
    return ["state": try store.export(), "type": type, "body": cipher.serialize().base64EncodedString()]
  }
  static func decrypt(_ state: String, _ name: String, _ deviceId: Int, _ type: Int, _ body: String) throws -> [String: Any] {
    let store = try SignalStateStore.parse(state)
    let remote = try address(name, deviceId)
    try require(try store.identity(for: remote, context: context) != nil, "TRUST_REQUIRED")
    let bytes = try decode(body, limit: maxMessage + 64 * 1024)
    let plaintext: Data
    switch type {
    case 2:
      plaintext = try signalDecrypt(message: SignalMessage(bytes: bytes), from: remote, to: store.localAddress, sessionStore: store, identityStore: store, context: context)
    case 3:
      plaintext = try signalDecryptPreKey(message: PreKeySignalMessage(bytes: bytes), from: remote, localAddress: store.localAddress, sessionStore: store, identityStore: store, preKeyStore: store, signedPreKeyStore: store, kyberPreKeyStore: store, context: context)
    default: throw SignalBridgeFailure(reason: "UNSUPPORTED_MESSAGE_TYPE")
    }
    try require(plaintext.count <= maxMessage, "MESSAGE_TOO_LARGE")
    guard let text = String(data: plaintext, encoding: .utf8) else { throw SignalBridgeFailure(reason: "INVALID_TEXT") }
    return ["state": try store.export(), "plaintext": text]
  }
  private static func remoteBundle(_ bundle: [String: Any], _ deviceId: Int) throws -> PreKeyBundle {
    let signed = try object(bundle, "signedPreKey"), kyber = try object(bundle, "kyberPreKey")
    let identityBytes = try decode(string(bundle, "identityKey"), limit: 33)
    try require(identityBytes.count == 33, "INVALID_IDENTITY")
    let identity = try IdentityKey(bytes: identityBytes)
    func ec(_ key: [String: Any]) throws -> PublicKey {
      let data = try decode(string(key, "publicKey"), limit: 33)
      try require(data.count == 33, "INVALID_PUBLIC_KEY")
      return try PublicKey(data)
    }
    func signature(_ key: [String: Any]) throws -> Data {
      let data = try decode(string(key, "signature"), limit: 64)
      try require(data.count == 64, "INVALID_SIGNATURE")
      return data
    }
    let registration = try integer(bundle, "registrationId", max: 16383)
    let signedId = try integer(signed, "id"), signedPublic = try ec(signed), signedSignature = try signature(signed)
    let kyberId = try integer(kyber, "id"), kyberPublic = try KEMPublicKey(decode(string(kyber, "publicKey"), limit: 8192)), kyberSignature = try signature(kyber)
    if let preKey = bundle["preKey"] as? [String: Any] {
      return try PreKeyBundle(registrationId: registration, deviceId: UInt32(deviceId), prekeyId: integer(preKey, "id"), prekey: ec(preKey), signedPrekeyId: signedId, signedPrekey: signedPublic, signedPrekeySignature: signedSignature, identity: identity, kyberPrekeyId: kyberId, kyberPrekey: kyberPublic, kyberPrekeySignature: kyberSignature)
    }
    return try PreKeyBundle(registrationId: registration, deviceId: UInt32(deviceId), signedPrekeyId: signedId, signedPrekey: signedPublic, signedPrekeySignature: signedSignature, identity: identity, kyberPrekeyId: kyberId, kyberPrekey: kyberPublic, kyberPrekeySignature: kyberSignature)
  }
  static func seal(_ plaintext: String, _ key: String, _ nonce: String, _ ad: String) throws -> String {
    let keyBytes = try decode(key, limit: 32), nonceBytes = try decode(nonce, limit: 12)
    try require(keyBytes.count == 32 && nonceBytes.count == 12, "INVALID_KEY_OR_NONCE")
    return try Aes256GcmSiv(key: keyBytes).encrypt(decode(plaintext, limit: maxFile), nonce: nonceBytes, associatedData: decode(ad, limit: 64 * 1024)).base64EncodedString()
  }
  static func open(_ ciphertext: String, _ key: String, _ nonce: String, _ ad: String) throws -> String {
    let keyBytes = try decode(key, limit: 32), nonceBytes = try decode(nonce, limit: 12)
    try require(keyBytes.count == 32 && nonceBytes.count == 12, "INVALID_KEY_OR_NONCE")
    let bytes = try decode(ciphertext, limit: maxFile + 16)
    try require(bytes.count >= 16, "INVALID_CIPHERTEXT")
    return try Aes256GcmSiv(key: keyBytes).decrypt(bytes, nonce: nonceBytes, associatedData: decode(ad, limit: 64 * 1024)).base64EncodedString()
  }
}

struct PersistentSignalState: Codable {
  var version = 1
  var libsignalVersion = SignalCore.version
  let localAddressName: String
  let localDeviceId: Int
  let identityKeyPair: String
  let registrationId: UInt32
  var nextPreKeyId: UInt32 = 1
  var signedPreKeyId: UInt32 = 1
  var kyberPreKeyId: UInt32 = 1
  var preKeys: [String: String] = [:]
  var signedPreKeys: [String: String] = [:]
  var kyberPreKeys: [String: String] = [:]
  var sessions: [String: String] = [:]
  var trustedIdentities: [String: String] = [:]
  var kyberUsed: [String: Bool] = [:]
  var senderKeys: [String: String] = [:]
}

final class SignalStateStore: IdentityKeyStore, PreKeyStore, SignedPreKeyStore, KyberPreKeyStore, SessionStore, SenderKeyStore {
  var state: PersistentSignalState
  let identityPair: IdentityKeyPair
  let localAddress: ProtocolAddress
  init(_ state: PersistentSignalState) throws {
    try SignalCore.require(state.version == 1 && state.libsignalVersion == SignalCore.version, "UNSUPPORTED_STATE")
    try SignalCore.require((1...16383).contains(state.registrationId), "INVALID_REGISTRATION")
    try SignalCore.require(state.preKeys.count <= SignalCore.maxPreKeys && state.signedPreKeys.count <= 64 && state.kyberPreKeys.count <= 64, "KEY_CAPACITY")
    try SignalCore.require(state.sessions.count <= 10000 && state.trustedIdentities.count <= 10000 && state.kyberUsed.count <= 50000, "STATE_CAPACITY")
    self.state = state
    identityPair = try IdentityKeyPair(bytes: SignalCore.decode(state.identityKeyPair, limit: 256))
    localAddress = try SignalCore.address(state.localAddressName, state.localDeviceId)
  }
  static func parse(_ text: String) throws -> SignalStateStore {
    try SignalCore.require(text.utf8.count <= SignalCore.maxState, "STATE_TOO_LARGE")
    return try SignalStateStore(JSONDecoder().decode(PersistentSignalState.self, from: Data(text.utf8)))
  }
  func export() throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(state)
    try SignalCore.require(data.count <= SignalCore.maxState, "STATE_TOO_LARGE")
    guard let text = String(data: data, encoding: .utf8) else { throw SignalBridgeFailure(reason: "INVALID_STATE") }
    return text
  }
  private func key(_ address: ProtocolAddress) -> String { "\(address.name)#\(address.deviceId)" }
  private func read(_ map: [String: String], _ key: String, limit: Int = 65536) throws -> Data? {
    guard let value = map[key] else { return nil }
    return try SignalCore.decode(value, limit: limit)
  }
  private func save(_ path: WritableKeyPath<PersistentSignalState, [String: String]>, _ key: String, _ data: Data, cap: Int) throws {
    try SignalCore.require(state[keyPath: path][key] != nil || state[keyPath: path].count < cap, "STATE_CAPACITY")
    state[keyPath: path][key] = data.base64EncodedString()
  }
  func pin(_ identity: IdentityKey, address: ProtocolAddress) throws {
    if let existing = try self.identity(for: address, context: SignalCore.context) { try SignalCore.require(existing == identity, "IDENTITY_CHANGED") }
    try save(\.trustedIdentities, key(address), identity.serialize(), cap: 10000)
  }
  func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair { identityPair }
  func localRegistrationId(context: StoreContext) throws -> UInt32 { state.registrationId }
  func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws -> IdentityChange {
    try SignalCore.require(try isTrustedIdentity(identity, for: address, direction: .sending, context: context), "IDENTITY_CHANGED")
    return .newOrUnchanged
  }
  func isTrustedIdentity(_ identity: IdentityKey, for address: ProtocolAddress, direction: Direction, context: StoreContext) throws -> Bool {
    return try self.identity(for: address, context: context).map { $0 == identity } ?? false
  }
  func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
    guard let bytes = try read(state.trustedIdentities, key(address), limit: 33) else { return nil }
    return try IdentityKey(bytes: bytes)
  }
  func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
    guard let bytes = try read(state.preKeys, String(id)) else { throw SignalError.invalidKeyIdentifier("Missing prekey") }
    return try PreKeyRecord(bytes: bytes)
  }
  func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws { try save(\.preKeys, String(id), record.serialize(), cap: SignalCore.maxPreKeys) }
  func removePreKey(id: UInt32, context: StoreContext) throws { state.preKeys.removeValue(forKey: String(id)) }
  func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
    guard let bytes = try read(state.signedPreKeys, String(id)) else { throw SignalError.invalidKeyIdentifier("Missing signed prekey") }
    return try SignedPreKeyRecord(bytes: bytes)
  }
  func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws { try save(\.signedPreKeys, String(id), record.serialize(), cap: 64) }
  func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
    guard let bytes = try read(state.kyberPreKeys, String(id)) else { throw SignalError.invalidKeyIdentifier("Missing Kyber prekey") }
    return try KyberPreKeyRecord(bytes: bytes)
  }
  func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws { try save(\.kyberPreKeys, String(id), record.serialize(), cap: 64) }
  func markKyberPreKeyUsed(id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: StoreContext) throws {
    _ = try loadKyberPreKey(id: id, context: context)
    let tuple = "\(id):\(signedPreKeyId):\(baseKey.serialize().base64EncodedString())"
    try SignalCore.require(state.kyberUsed[tuple] == nil, "REUSED_BASE_KEY")
    try SignalCore.require(state.kyberUsed.count < 50000, "REPLAY_RECORD_CAPACITY")
    state.kyberUsed[tuple] = true // Retain last-resort Kyber record and durable replay tuple.
  }
  func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
    guard let bytes = try read(state.sessions, key(address), limit: SignalCore.maxMessage) else { return nil }
    return try SessionRecord(bytes: bytes)
  }
  func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
    return try addresses.map { address in
      guard let record = try loadSession(for: address, context: context) else { throw SignalError.sessionNotFound("Missing session") }
      return record
    }
  }
  func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws { try save(\.sessions, key(address), record.serialize(), cap: 10000) }
  func storeSenderKey(from sender: ProtocolAddress, distributionId: UUID, record: SenderKeyRecord, context: StoreContext) throws {
    try save(\.senderKeys, "\(key(sender)):\(distributionId.uuidString.lowercased())", record.serialize(), cap: 10000)
  }
  func loadSenderKey(from sender: ProtocolAddress, distributionId: UUID, context: StoreContext) throws -> SenderKeyRecord? {
    guard let bytes = try read(state.senderKeys, "\(key(sender)):\(distributionId.uuidString.lowercased())") else { return nil }
    return try SenderKeyRecord(bytes: bytes)
  }
}
