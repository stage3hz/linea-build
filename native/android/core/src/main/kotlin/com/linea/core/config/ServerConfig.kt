package com.linea.core.config

/**
 * Where the app connects. INVIZENT always talks to its own server; the address cannot be changed in the app.
 * The one exception is a test build, which may be pointed at an HTTPS server on localhost and nowhere else.
 */
class ServerConfig private constructor(
    /** The account's realm: keys and history on the device are tied to it, never to the address in use. */
    val serverUrl: String,
    /** Earlier builds connected through these; local data created there is reused. */
    val legacyServerUrls: List<String>,
    /** Reserve entrance, used only when no direct address answers. */
    val edgeServerUrls: List<String>,
    /** True only for a build made for the local test server. Never in a release build. */
    val testBuild: Boolean,
) {
    companion object {
        const val PRODUCTION_SERVER_URL = "https://api.invizent.com"
        private val LOCAL_TEST_SERVER = Regex("""^https://localhost:\d{2,5}$""")

        val PRODUCTION = ServerConfig(
            serverUrl = PRODUCTION_SERVER_URL,
            legacyServerUrls = listOf("https://141-133-194-51.nip.io"),
            edgeServerUrls = listOf("https://invizent-api.invizent-8165e2.workers.dev"),
            testBuild = false,
        )

        /** [localTestServer] is honoured only as `https://localhost:<port>`; anything else gives the real server. */
        fun resolve(localTestServer: String?): ServerConfig =
            if (localTestServer != null && LOCAL_TEST_SERVER.matches(localTestServer)) {
                ServerConfig(localTestServer, emptyList(), emptyList(), testBuild = true)
            } else {
                PRODUCTION
            }
    }
}
