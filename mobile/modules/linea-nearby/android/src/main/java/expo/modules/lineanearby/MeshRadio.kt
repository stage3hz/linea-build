package expo.modules.lineanearby

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.UUID

/**
 * Bluetooth LE link between Invizent phones. Every phone is both a GATT server (advertises the
 * Invizent service) and a client (scans for it). Text messages (JSON from the JS mesh layer) are
 * cut into frames that fit the negotiated MTU and joined again on the other side.
 * The radio carries only what JS gives it — already Signal-encrypted packets and id lists.
 *
 * Frame: [flags:1][message:2][payload]; flags bit0 = last frame of the message.
 */
@SuppressLint("MissingPermission") // NearbyModule starts this only after the permission is granted
class MeshRadio(
  private val context: Context,
  private val onPeer: (String) -> Unit,
  private val onData: (String, String) -> Unit,
  private val onLost: (String) -> Unit,
) {
  companion object {
    val SERVICE: UUID = UUID.fromString("eed79feb-13cc-417a-be0f-7e122c594e46")
    val RX: UUID = UUID.fromString("450fc551-17fe-4cef-a80b-4336f959d46d") // peers write to us
    val TX: UUID = UUID.fromString("2d46e529-c62c-431a-9fbd-164d619c2baa") // we notify peers
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val MAX_MESSAGE = 64 * 1024
    const val MAX_PEERS = 6
  }

  private val main = Handler(Looper.getMainLooper())
  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter get() = manager.adapter
  /** Random per start; decides which side connects so two phones open one link, not two. */
  private val nodeId = ByteArray(4).also { SecureRandom().nextBytes(it) }
  private var server: BluetoothGattServer? = null
  private var running = false

  private class Link(val id: String) {
    var gatt: BluetoothGatt? = null          // we are the client
    var device: BluetoothDevice? = null      // or they are (we notify them)
    var mtu = 23
    val queue = ArrayDeque<ByteArray>()
    var busy = false
    var nextMessage = 0
    val incoming = HashMap<Int, java.io.ByteArrayOutputStream>()
    var ready = false
  }
  private val links = HashMap<String, Link>()
  private val serverMtu = HashMap<String, Int>()

  fun start() {
    if (running) return
    running = true
    openServer()
    advertise()
    scan()
  }

  fun stop() {
    running = false
    runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
    runCatching { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
    for (link in links.values) runCatching { link.gatt?.close() }
    links.clear()
    runCatching { server?.close() }; server = null
  }

  fun send(peer: String, text: String): Boolean {
    val link = links[peer] ?: return false
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_MESSAGE || !link.ready) return false
    val chunk = (link.mtu - 3 - 3).coerceAtLeast(17)
    val message = link.nextMessage++ and 0xFFFF
    var offset = 0
    do {
      val end = minOf(bytes.size, offset + chunk)
      val frame = ByteArray(3 + end - offset)
      frame[0] = if (end == bytes.size) 1 else 0
      frame[1] = (message shr 8).toByte(); frame[2] = message.toByte()
      System.arraycopy(bytes, offset, frame, 3, end - offset)
      link.queue.add(frame)
      offset = end
    } while (offset < bytes.size)
    pump(link)
    return true
  }

  // ---- receiving frames (same for both roles) ----
  private fun accept(link: Link, frame: ByteArray) {
    if (frame.size < 3) return
    val message = ((frame[1].toInt() and 0xFF) shl 8) or (frame[2].toInt() and 0xFF)
    val buffer = link.incoming.getOrPut(message) { java.io.ByteArrayOutputStream() }
    if (buffer.size() + frame.size - 3 > MAX_MESSAGE || link.incoming.size > 8) { link.incoming.clear(); return }
    buffer.write(frame, 3, frame.size - 3)
    if (frame[0].toInt() and 1 == 1) {
      link.incoming.remove(message)
      val text = runCatching { buffer.toByteArray().toString(Charsets.UTF_8) }.getOrNull() ?: return
      main.post { onData(link.id, text) }
    }
  }

  // ---- sending frames one at a time (BLE allows one operation in flight) ----
  private fun pump(link: Link) {
    if (link.busy) return
    val frame = link.queue.poll() ?: return
    link.busy = true
    val ok = link.gatt?.let { gatt ->
      val rx = gatt.getService(SERVICE)?.getCharacteristic(RX) ?: return@let false
      if (Build.VERSION.SDK_INT >= 33) gatt.writeCharacteristic(rx, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
      else { @Suppress("DEPRECATION") run { rx.value = frame; rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; gatt.writeCharacteristic(rx) } }
    } ?: link.device?.let { device ->
      val tx = server?.getService(SERVICE)?.getCharacteristic(TX) ?: return@let false
      if (Build.VERSION.SDK_INT >= 33) server?.notifyCharacteristicChanged(device, tx, false, frame) == BluetoothGatt.GATT_SUCCESS
      else { @Suppress("DEPRECATION") run { tx.value = frame; server?.notifyCharacteristicChanged(device, tx, false) == true } }
    } ?: false
    if (!ok) { link.busy = false; link.queue.clear(); drop(link.id) }
  }
  private fun sent(id: String) { val link = links[id] ?: return; link.busy = false; pump(link) }

  private fun drop(id: String) {
    val link = links.remove(id) ?: return
    runCatching { link.gatt?.close() }
    main.post { onLost(id) }
  }

  // ---- server role: others connect to us ----
  private fun openServer() {
    val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(BluetoothGattCharacteristic(RX, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE))
    val tx = BluetoothGattCharacteristic(TX, BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
    tx.addDescriptor(BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
    service.addCharacteristic(tx)
    server = manager.openGattServer(context, serverCallback)?.also { it.addService(service) }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_DISCONNECTED) main.post { serverMtu.remove(device.address); if (links[device.address]?.gatt == null) drop(device.address) }
    }
    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) { main.post { serverMtu[device.address] = mtu; links[device.address]?.mtu = mtu } }
    override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
      if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      if (characteristic.uuid != RX || value == null) return
      main.post { links[device.address]?.let { accept(it, value) } }
    }
    override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
      if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      if (descriptor.uuid != CCCD) return
      // The other phone subscribed to our notifications: the link works both ways now.
      main.post {
        if (links.size >= MAX_PEERS && !links.containsKey(device.address)) return@post
        val link = links.getOrPut(device.address) { Link(device.address) }
        link.device = device; link.ready = true; link.mtu = serverMtu[device.address] ?: link.mtu
        onPeer(link.id)
      }
    }
    override fun onNotificationSent(device: BluetoothDevice, status: Int) { main.post { sent(device.address) } }
  }

  // ---- advertising ----
  private val advertiseCallback = object : AdvertiseCallback() {}
  private fun advertise() {
    val settings = AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED).setConnectable(true).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).build()
    // No device name and no account data: only the service id and a random per-start node id.
    val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE)).addServiceData(ParcelUuid(SERVICE), nodeId).build()
    runCatching { adapter?.bluetoothLeAdvertiser?.startAdvertising(settings, data, advertiseCallback) }
  }

  // ---- client role: we connect to others ----
  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val theirs = result.scanRecord?.getServiceData(ParcelUuid(SERVICE)) ?: return
      // The phone with the smaller node id connects; the other one waits to be connected.
      if (compare(nodeId, theirs) >= 0) return
      val address = result.device.address
      main.post {
        if (!running || links.containsKey(address) || links.size >= MAX_PEERS) return@post
        val link = Link(address); links[address] = link
        link.gatt = result.device.connectGatt(context, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
      }
    }
  }
  private fun scan() {
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
    runCatching { adapter?.bluetoothLeScanner?.startScan(listOf(filter), settings, scanCallback) }
  }
  private fun compare(a: ByteArray, b: ByteArray): Int {
    for (i in 0 until minOf(a.size, b.size)) { val d = (a[i].toInt() and 0xFF) - (b[i].toInt() and 0xFF); if (d != 0) return d }
    return a.size - b.size
  }

  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val id = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) gatt.requestMtu(517)
      else if (newState == BluetoothProfile.STATE_DISCONNECTED) main.post { drop(id) }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      main.post { links[gatt.device.address]?.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23 }
      gatt.discoverServices()
    }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val tx = gatt.getService(SERVICE)?.getCharacteristic(TX)
      val cccd = tx?.getDescriptor(CCCD)
      if (status != BluetoothGatt.GATT_SUCCESS || tx == null || cccd == null) { main.post { drop(gatt.device.address) }; return }
      gatt.setCharacteristicNotification(tx, true)
      if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      else { @Suppress("DEPRECATION") run { cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; gatt.writeDescriptor(cccd) } }
    }
    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      main.post {
        val link = links[gatt.device.address] ?: return@post
        if (status != BluetoothGatt.GATT_SUCCESS) return@post drop(link.id)
        link.ready = true
        onPeer(link.id)
      }
    }
    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      main.post { if (status == BluetoothGatt.GATT_SUCCESS) sent(gatt.device.address) else drop(gatt.device.address) }
    }
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (characteristic.uuid != TX) return
      val copy = value.copyOf()
      main.post { links[gatt.device.address]?.let { accept(it, copy) } }
    }
    @Deprecated("Android 12 and older")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= 33 || characteristic.uuid != TX) return
      @Suppress("DEPRECATION") val copy = characteristic.value?.copyOf() ?: return
      main.post { links[gatt.device.address]?.let { accept(it, copy) } }
    }
  }
}
