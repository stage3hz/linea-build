import CoreBluetooth
import Foundation

/// Bluetooth LE link between Invizent phones — the iPhone side of MeshRadio.kt (same service,
/// same characteristics, same frames: [flags:1][message:2][payload], flags bit0 = last frame).
/// iOS cannot put data into its advertisement, so an iPhone always connects as the client
/// (Android decides by node id); a duplicate link between two iPhones is harmless — the mesh
/// layer ignores packets it already has.
final class MeshRadio: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {
  static let service = CBUUID(string: "EED79FEB-13CC-417A-BE0F-7E122C594E46")
  static let rx = CBUUID(string: "450FC551-17FE-4CEF-A80B-4336F959D46D") // peers write to us
  static let tx = CBUUID(string: "2D46E529-C62C-431A-9FBD-164D619C2BAA") // we notify peers
  static let maxMessage = 64 * 1024
  static let maxPeers = 6

  private final class Link {
    let id: String
    var peripheral: CBPeripheral?   // we are the client
    var rxChar: CBCharacteristic?
    var central: CBCentral?         // they are the client (we notify them)
    var payload = 20
    var queue: [Data] = []
    var busy = false
    var ready = false
    var nextMessage: UInt16 = 0
    var incoming: [UInt16: Data] = [:]
    init(id: String) { self.id = id }
  }

  private let onPeer: (String) -> Void
  private let onData: (String, String) -> Void
  private let onLost: (String) -> Void
  private var central: CBCentralManager?
  private var server: CBPeripheralManager?
  private var txChar: CBMutableCharacteristic?
  private var links: [String: Link] = [:]
  private var running = false

  init(onPeer: @escaping (String) -> Void, onData: @escaping (String, String) -> Void, onLost: @escaping (String) -> Void) {
    self.onPeer = onPeer; self.onData = onData; self.onLost = onLost
  }

  func start() {
    guard !running else { return }
    running = true
    central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    server = CBPeripheralManager(delegate: self, queue: .main, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
  }

  func stop() {
    running = false
    central?.stopScan()
    for link in links.values { if let p = link.peripheral { central?.cancelPeripheralConnection(p) } }
    links.removeAll()
    server?.stopAdvertising(); server?.removeAllServices()
    central = nil; server = nil; txChar = nil
  }

  func send(_ peer: String, _ text: String) -> Bool {
    guard let link = links[peer], link.ready, let bytes = text.data(using: .utf8), bytes.count <= MeshRadio.maxMessage else { return false }
    let chunk = max(17, link.payload - 3)
    let message = link.nextMessage; link.nextMessage &+= 1
    var offset = 0
    repeat {
      let end = min(bytes.count, offset + chunk)
      var frame = Data([end == bytes.count ? 1 : 0, UInt8(message >> 8), UInt8(message & 0xFF)])
      frame.append(bytes.subdata(in: offset..<end))
      link.queue.append(frame)
      offset = end
    } while offset < bytes.count
    pump(link)
    return true
  }

  // MARK: frames
  private func accept(_ link: Link, _ frame: Data) {
    guard frame.count >= 3 else { return }
    let bytes = [UInt8](frame)
    let message = UInt16(bytes[1]) << 8 | UInt16(bytes[2])
    var buffer = link.incoming[message] ?? Data()
    if buffer.count + frame.count - 3 > MeshRadio.maxMessage || link.incoming.count > 8 { link.incoming.removeAll(); return }
    buffer.append(frame.subdata(in: 3..<frame.count))
    if bytes[0] & 1 == 1 {
      link.incoming[message] = nil
      if let text = String(data: buffer, encoding: .utf8) { onData(link.id, text) }
    } else {
      link.incoming[message] = buffer
    }
  }

  private func pump(_ link: Link) {
    guard !link.busy, let frame = link.queue.first else { return }
    if let p = link.peripheral, let rx = link.rxChar {
      link.busy = true; link.queue.removeFirst()
      p.writeValue(frame, for: rx, type: .withResponse)
    } else if let c = link.central, let tx = txChar, let server {
      // false = the outgoing queue is full; peripheralManagerIsReady will call pump again.
      if server.updateValue(frame, for: tx, onSubscribedCentrals: [c]) { link.queue.removeFirst(); pump(link) }
    }
  }

  private func drop(_ id: String) {
    guard let link = links.removeValue(forKey: id) else { return }
    if let p = link.peripheral { central?.cancelPeripheralConnection(p) }
    onLost(id)
  }

  // MARK: client role
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state == .poweredOn, running { central.scanForPeripherals(withServices: [MeshRadio.service], options: nil) }
  }
  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    let id = peripheral.identifier.uuidString
    guard running, links[id] == nil, links.count < MeshRadio.maxPeers else { return }
    let link = Link(id: id); link.peripheral = peripheral; links[id] = link
    central.connect(peripheral, options: nil)
  }
  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.delegate = self
    peripheral.discoverServices([MeshRadio.service])
  }
  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) { drop(peripheral.identifier.uuidString) }
  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) { drop(peripheral.identifier.uuidString) }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil, let s = peripheral.services?.first(where: { $0.uuid == MeshRadio.service }) else { return drop(peripheral.identifier.uuidString) }
    peripheral.discoverCharacteristics([MeshRadio.rx, MeshRadio.tx], for: s)
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    let id = peripheral.identifier.uuidString
    guard error == nil, let link = links[id],
          let rx = service.characteristics?.first(where: { $0.uuid == MeshRadio.rx }),
          let tx = service.characteristics?.first(where: { $0.uuid == MeshRadio.tx }) else { return drop(id) }
    link.rxChar = rx
    peripheral.setNotifyValue(true, for: tx)
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    let id = peripheral.identifier.uuidString
    guard let link = links[id] else { return }
    if error != nil || !characteristic.isNotifying { return drop(id) }
    link.payload = peripheral.maximumWriteValueLength(for: .withResponse)
    link.ready = true
    onPeer(id)
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == MeshRadio.tx, let value = characteristic.value, let link = links[peripheral.identifier.uuidString] else { return }
    accept(link, value)
  }
  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    let id = peripheral.identifier.uuidString
    guard let link = links[id] else { return }
    if error != nil { return drop(id) }
    link.busy = false; pump(link)
  }

  // MARK: server role
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard peripheral.state == .poweredOn, running, txChar == nil else { return }
    let rx = CBMutableCharacteristic(type: MeshRadio.rx, properties: [.write], value: nil, permissions: [.writeable])
    let tx = CBMutableCharacteristic(type: MeshRadio.tx, properties: [.notify], value: nil, permissions: [.readable])
    let service = CBMutableService(type: MeshRadio.service, primary: true)
    service.characteristics = [rx, tx]
    txChar = tx
    peripheral.add(service)
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    // Only the service id: no device name, no account data.
    if error == nil { peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [MeshRadio.service]]) }
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    let id = central.identifier.uuidString
    guard links[id] != nil || links.count < MeshRadio.maxPeers else { return }
    let link = links[id] ?? Link(id: id)
    link.central = central; link.payload = central.maximumUpdateValueLength; link.ready = true
    links[id] = link
    onPeer(id)
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    if links[central.identifier.uuidString]?.peripheral == nil { drop(central.identifier.uuidString) }
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for request in requests where request.characteristic.uuid == MeshRadio.rx {
      if let value = request.value, let link = links[request.central.identifier.uuidString] { accept(link, value) }
    }
    if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
  }
  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    for link in links.values where link.central != nil { pump(link) }
  }
}
