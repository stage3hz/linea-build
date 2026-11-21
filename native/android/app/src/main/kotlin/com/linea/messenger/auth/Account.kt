package com.linea.messenger.auth

import android.content.Context
import android.os.Build
import com.linea.messenger.Demo
import com.linea.messenger.core.Core
import com.linea.messenger.storage.Keystore

/** Where the app connects, and the session kept on this device. */
object Account {
  private const val PRODUCTION = "https://api.invizent.com"
  private const val TOKEN_NAME = "linea.session.v1"
  private const val PREFERENCES = "invizent"
  private const val USER_KEY = "invizent.session-user.v1"

  private var app: Context? = null

  /** The app's version, as the server is told it. */
  var appVersion: String = "0"
    private set

  /** Called once, before anything else of the account is asked. */
  fun start(context: Context) {
    val kept = context.applicationContext
    app = kept
    appVersion = try { kept.packageManager.getPackageInfo(kept.packageName, 0).versionName } catch (_: Exception) { null } ?: "0"
  }

  /** The server. A debug build may be pointed at a local test server by a launch argument (see `Demo` of
   *  src/debug); a release build has no such argument and always answers the real one. */
  val server: String get() = Demo.testServer ?: PRODUCTION

  /** The session's token: in the keystore, under the name the previous app used, so an update stays signed in. */
  var token: String?
    get() = app?.let { context -> try { Keystore.get(context, TOKEN_NAME) } catch (_: Exception) { null } }
    set(value) {
      val context = app ?: return
      try { if (value != null) Keystore.set(context, TOKEN_NAME, value) else Keystore.remove(context, TOKEN_NAME) } catch (_: Exception) {}
    }

  /** What the server is told about this device at sign-in (shown in «Активные сеансы»): its kind and system,
   *  as the previous app named them; nothing that locates or identifies it. */
  val deviceFields: Map<String, Any?>
    get() {
      val name = deviceName(Build.BRAND?.takeIf { it.isNotBlank() } ?: Build.MANUFACTURER, Build.MODEL)
      val fields = linkedMapOf<String, Any?>("deviceName" to (name ?: "Android"), "platform" to "android")
      if (name != null) fields["deviceModel"] = name
      fields["osVersion"] = Build.VERSION.RELEASE?.takeIf { it.isNotBlank() }?.let { "Android $it" } ?: "Android"
      fields["appVersion"] = appVersion
      return fields
    }

  /** «Samsung SM-S911B», or the model alone when it already starts with the maker's name; null without a model. */
  fun deviceName(brand: String?, model: String?): String? {
    val maker = brand?.trim()?.take(80).orEmpty()
    val kind = model?.trim()?.take(80).orEmpty()
    if (kind.isEmpty()) return null
    return if (maker.isNotEmpty() && !kind.lowercase().startsWith(maker.lowercase())) maker.replaceFirstChar { it.uppercase() } + " " + kind else kind
  }

  /** The account's public profile as the server last gave it: lets the app open without waiting for the network. */
  var cachedUser: Map<String, Any?>?
    get() = Core.map(Core.value(app?.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)?.getString(USER_KEY, null)))
    set(value) {
      val kept = app?.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE) ?: return
      val text = value?.let { Core.text(it) }
      if (text != null) kept.edit().putString(USER_KEY, text).apply() else kept.edit().remove(USER_KEY).apply()
    }
}
