package com.linea.core.config

/**
 * The version this build reports to the server (header `X-Linea-Client`). The server may refuse builds it has
 * retired, so this is bumped together with the app's `versionName` at every release.
 */
const val APP_VERSION = "0.16.3"

/** The platform label of this app in `X-Linea-Client`, the same the previous Android app sent. */
const val CLIENT_PLATFORM = "android"

object ClientHeader {
    const val NAME = "X-Linea-Client"

    /** `invizent; v=<version>; p=<platform>` (server: clientgate.js). */
    fun value(version: String = APP_VERSION, platform: String = CLIENT_PLATFORM): String = "invizent; v=$version; p=$platform"
}
