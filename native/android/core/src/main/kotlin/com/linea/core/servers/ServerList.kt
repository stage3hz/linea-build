package com.linea.core.servers

import com.linea.core.json.JsonException
import com.linea.core.json.JsonNumber
import com.linea.core.json.JsonValue
import com.linea.core.json.asArray
import com.linea.core.json.asObject
import com.linea.core.json.asString
import java.net.URI
import java.util.Base64

data class ServerEntry(val url: String, val region: String? = null)

data class ServerList(val version: Long, val issuedAt: String, val servers: List<ServerEntry>)

/** The list as the server hands it out: the exact signed text and its signature (base64). */
data class SignedServerList(val payload: String, val sig: String)

/** Checks an Ed25519 signature. Raw 32-byte public key, raw 64-byte signature. */
fun interface ListSignatureVerifier {
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
}

/**
 * The signed server list. The owner signs it offline (deploy/servers.mjs); the app only accepts lists signed by a
 * key built into it, so a hijacked DNS name or a captured data centre cannot point people at a foreign server.
 */
object ServerListRules {
    /** Only our own domains may ever carry the account. */
    val TRUSTED_HOST = Regex("""^(?:[a-z0-9-]+\.)*invizent\.(?:com|ru)$|^141-133-194-51\.nip\.io$|^invizent-api\.invizent-8165e2\.workers\.dev$""")

    private val SIGNATURE = Regex("^[A-Za-z0-9+/=]{80,100}$")
    private val PUBLIC_KEY = Regex("^[A-Za-z0-9+/=]{40,48}$")
    private val HOST_SHAPE = Regex("^[A-Za-z0-9.-]+$")

    /** `https://host` for an address on our domains, null for anything else. */
    fun normalizeServer(url: String?): String? {
        if (url == null) return null
        val uri = try { URI(url) } catch (_: Exception) { return null }
        if (!"https".equals(uri.scheme, ignoreCase = true) || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
        // java.net.URI leaves the host empty for authorities it cannot read (such as a name with «_»); those are refused.
        val host = uri.host?.lowercase() ?: return null
        if (!HOST_SHAPE.matches(host) || !TRUSTED_HOST.matches(host)) return null
        if (uri.port != -1 && uri.port != 443) return null
        return "https://$host"
    }

    /**
     * Checks the signature with the built-in keys and the content rules. Returns the list or null.
     * [minVersion] stops an attacker from replaying an older, still validly signed list.
     */
    fun verifyServerList(signed: SignedServerList?, keys: List<String>, verifier: ListSignatureVerifier, minVersion: Long = 0): ServerList? {
        if (signed == null) return null
        val (payload, sig) = signed
        if (payload.length > 16_384 || !SIGNATURE.matches(sig)) return null
        val message = payload.toByteArray(Charsets.UTF_8)
        val signedByUs = keys.any { key ->
            try { PUBLIC_KEY.matches(key) && verifier.verify(base64(key), message, base64(sig)) } catch (_: Exception) { false }
        }
        if (!signedByUs) return null
        val list = try { JsonValue.parse(payload).asObject() } catch (_: JsonException) { null } ?: return null
        val version = (list["version"] as? JsonNumber)?.safeLong ?: return null
        val entries = list["servers"].asArray() ?: return null
        if (version < minVersion || entries.size < 1 || entries.size > 32) return null
        val servers = ArrayList<ServerEntry>()
        for (entry in entries) {
            val fields = entry.asObject()
            val url = normalizeServer(fields?.get("url").asString()) ?: return null
            if (servers.any { it.url == url }) return null
            servers.add(ServerEntry(url, fields?.get("region").asString()?.takeIf { it.length <= 40 }))
        }
        return ServerList(version, issuedAtText(list["issuedAt"]), servers)
    }

    private fun issuedAtText(value: JsonValue?): String = value.asString() ?: ""

    private fun base64(text: String): ByteArray = Base64.getDecoder().decode(text)

    /**
     * Picks the server to use. Measured round trips decide; the current one is kept unless it fails or another is
     * clearly faster (≥40 ms and ≥30 %), so the app does not flip-flop.
     */
    fun chooseServer(current: String?, rtt: Map<String, Long?>): String? {
        val alive = rtt.entries.mapNotNull { (url, ms) -> ms?.let { url to it } }.sortedBy { it.second }
        if (alive.isEmpty()) return current
        val (bestUrl, best) = alive[0]
        val now = current?.let { rtt[it] }
        if (current != null && now != null && !(now - best >= 40 && best <= now * 0.7)) return current
        return bestUrl
    }

    /**
     * After [failed] stopped answering: the next server to try. Measured-alive servers first (fastest first), then
     * never-measured ones; servers whose last probe failed or that failed recently come after — and if every other
     * server is known dead, we stay on [failed] (a slow link drops requests now and then; jumping to a dead server
     * would waste a whole upload).
     *
     * In [rtt] a key with a null value is a server whose probe failed; an absent key is one never measured.
     */
    fun fallbackServer(failed: String, all: List<String>, rtt: Map<String, Long?>, down: Map<String, Long>, now: Long, downMs: Long): String? {
        val others = all.filter { it != failed }
        if (others.isEmpty()) return null
        fun recentlyDown(url: String) = (down[url] ?: 0L) != 0L && now - down.getValue(url) < downMs
        fun rank(url: String) = if (recentlyDown(url) || (rtt.containsKey(url) && rtt[url] == null)) 2 else if (rtt[url] != null) 0 else 1
        val order = Comparator<String> { a, b ->
            val byRank = rank(a) - rank(b)
            when {
                byRank != 0 -> byRank
                rank(a) == 0 -> rtt.getValue(a)!!.compareTo(rtt.getValue(b)!!)
                rank(a) == 2 -> (down[a] ?: 0L).compareTo(down[b] ?: 0L)
                else -> 0
            }
        }
        val best = others.sortedWith(order)[0] // a stable sort, as in the reference
        return if (rank(best) == 2 && failed in all) failed else best
    }
}
