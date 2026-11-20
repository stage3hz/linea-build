package com.linea.core.device

import com.linea.core.config.APP_VERSION
import com.linea.core.config.CLIENT_PLATFORM
import com.linea.core.json.JsonValue
import com.linea.core.json.json

/**
 * What this build tells the server about itself at sign-in («Активные сеансы»): platform, device model, OS version
 * and app version. Nothing here locates the device.
 */
data class DeviceInfo(
    val platform: String,
    /** Short name shown in the sessions list and in «Новый вход: …». */
    val deviceName: String,
    val deviceModel: String?,
    val osVersion: String?,
    val appVersion: String,
) {
    /** The body fields `/auth/login` accepts, in the order the reference sends them; absent values are left out. */
    fun loginFields(): List<Pair<String, JsonValue?>> = listOf(
        "deviceName" to deviceName.json(),
        "platform" to platform.json(),
        "deviceModel" to deviceModel?.json(),
        "osVersion" to osVersion?.json(),
        "appVersion" to appVersion.json(),
    )

    companion object {
        /**
         * An Android device from `Build.BRAND` (or `MANUFACTURER`), `Build.MODEL` and `Build.VERSION.RELEASE`:
         * «Google Pixel 8», «Android 15». The brand is not repeated when the model already starts with it.
         */
        fun android(brand: String?, model: String?, release: String?, appVersion: String = APP_VERSION): DeviceInfo {
            val brandText = text(brand)
            val modelText = text(model)
            val name = modelText?.let {
                if (brandText != null && !it.lowercase().startsWith(brandText.lowercase())) "${brandText.replaceFirstChar(Char::uppercaseChar)} $it" else it
            }
            val releaseText = text(release)
            return DeviceInfo(CLIENT_PLATFORM, name ?: "Android", name, if (releaseText != null) "Android $releaseText" else "Android", appVersion)
        }

        private fun text(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }?.take(80)
    }
}
