package expo.modules.lineanearby

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Radio, permission and network state for messages without internet.
 * Only the «Nearby devices» permissions of Android 12+ are used (with neverForLocation in the
 * manifest): no location, no list of other apps. Older Android is reported as unsupported.
 */
class NearbyModule : Module() {
  private val permissions = arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
  private var receiver: BroadcastReceiver? = null
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var pendingEnable: Promise? = null
  private var radio: MeshRadio? = null

  private fun context(): Context = appContext.reactContext ?: throw IllegalStateException("CONTEXT_UNAVAILABLE")
  private fun supported() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
    context().packageManager.hasSystemFeature("android.hardware.bluetooth_le")
  private fun adapter(): BluetoothAdapter? = (context().getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private fun internet(): Boolean {
    val manager = context().getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val caps = manager.getNetworkCapabilities(manager.activeNetwork ?: return false) ?: return false
    // VALIDATED: the system itself reached the internet through this network (Wi-Fi without
    // internet, a captive portal or a mobile network with no data are not validated).
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  }

  private fun permission(onResult: (String) -> Unit, ask: Boolean) {
    val manager = appContext.permissions ?: return onResult("undetermined")
    val listener = expo.modules.interfaces.permissions.PermissionsResponseListener { result ->
      val all = permissions.mapNotNull { result[it] }
      onResult(when {
        all.size == permissions.size && all.all { it.status == PermissionsStatus.GRANTED } -> "granted"
        all.any { it.status == PermissionsStatus.DENIED && !it.canAskAgain } -> "blocked"
        all.any { it.status == PermissionsStatus.DENIED } -> "denied"
        else -> "undetermined"
      })
    }
    if (ask) manager.askForPermissions(listener, *permissions) else manager.getPermissions(listener, *permissions)
  }

  private fun snapshot(permission: String): Map<String, Any> {
    val ok = supported()
    val enabled = if (ok && permission == "granted") (if (adapter()?.isEnabled == true) "on" else "off") else "unknown"
    return mapOf("supported" to ok, "permission" to if (ok) permission else "blocked", "bluetooth" to enabled, "internet" to internet())
  }
  private fun current(done: (Map<String, Any>) -> Unit) {
    if (!supported()) return done(snapshot("blocked"))
    permission({ done(snapshot(it)) }, ask = false)
  }
  private fun emitChange() = current { sendEvent("change", it) }

  override fun definition() = ModuleDefinition {
    Name("LineaNearby")
    Events("change", "meshPeer", "meshData", "meshLost")

    OnStartObserving {
      val ctx = context()
      receiver = object : BroadcastReceiver() { override fun onReceive(c: Context?, i: Intent?) = emitChange() }
      ctx.registerReceiver(receiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
      val manager = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = emitChange()
        override fun onLost(network: Network) = emitChange()
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = emitChange()
      }.also { manager.registerDefaultNetworkCallback(it) }
    }
    OnDestroy { radio?.stop(); radio = null }
    OnStopObserving {
      val ctx = appContext.reactContext ?: return@OnStopObserving
      receiver?.let { runCatching { ctx.unregisterReceiver(it) } }; receiver = null
      callback?.let { runCatching { (ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } }; callback = null
    }

    AsyncFunction("state") { promise: Promise -> current { promise.resolve(it) } }

    AsyncFunction("requestPermission") { promise: Promise ->
      if (!supported()) return@AsyncFunction promise.resolve(snapshot("blocked"))
      permission({ promise.resolve(snapshot(it)) }, ask = true)
    }

    AsyncFunction("requestEnable") { promise: Promise ->
      val activity = appContext.currentActivity
      if (!supported() || activity == null) return@AsyncFunction current { promise.resolve(it) }
      if (adapter()?.isEnabled == true) return@AsyncFunction current { promise.resolve(it) }
      try {
        pendingEnable?.let { old -> current { old.resolve(it) } }
        pendingEnable = promise
        // The system dialog «Allow Invizent to turn on Bluetooth?» — apps targeting Android 13+
        // cannot switch Bluetooth on silently (BluetoothAdapter.enable() always returns false).
        activity.startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE)
      } catch (error: SecurityException) {
        pendingEnable = null; current { promise.resolve(it) }
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_ENABLE) return@OnActivityResult
      val waiting = pendingEnable ?: return@OnActivityResult
      pendingEnable = null
      current { waiting.resolve(it) }
    }

    // Mesh link: only while the app asks for it (no internet), only with the permission granted.
    AsyncFunction("startMesh") { promise: Promise ->
      current { state ->
        if (state["permission"] != "granted" || state["bluetooth"] != "on") return@current promise.resolve(false)
        val r = radio ?: MeshRadio(context(), { sendEvent("meshPeer", mapOf("peer" to it)) }, { peer, text -> sendEvent("meshData", mapOf("peer" to peer, "text" to text)) }, { sendEvent("meshLost", mapOf("peer" to it)) }).also { radio = it }
        r.start(); promise.resolve(true)
      }
    }
    AsyncFunction("stopMesh") { radio?.stop(); radio = null }
    AsyncFunction("sendMesh") { peer: String, text: String -> radio?.send(peer, text) ?: false }

    AsyncFunction("openSettings") {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context().packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context().startActivity(intent)
    }
  }

  private companion object { const val REQUEST_ENABLE = 0x4E42 }
}
