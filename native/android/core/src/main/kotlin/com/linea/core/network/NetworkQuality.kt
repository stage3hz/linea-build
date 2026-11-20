package com.linea.core.network

/** slow ≈ EDGE/2G, medium ≈ 3G, fast ≈ LTE/Wi-Fi. */
enum class NetworkTier { SLOW, MEDIUM, FAST }

enum class RequestKind { SEND, READ, UPLOAD }

data class QualityState(val rttMs: Double?, val kbps: Double?, val tier: NetworkTier) {
    companion object {
        val START = QualityState(null, null, NetworkTier.FAST)
    }
}

/**
 * How fast the connection really is right now, measured from the app's own requests (no permissions, no list of
 * networks): the round-trip time of small requests and the throughput of bigger answers.
 */
object QualityRules {
    /** The weight of a new sample: one odd request does not change the tier. */
    private const val ALPHA = 0.2

    private fun ewma(old: Double?, sample: Double): Double = if (old == null) sample else old + ALPHA * (sample - old)

    fun classify(rttMs: Double?, kbps: Double?): NetworkTier = when {
        (kbps != null && kbps < 200) || (rttMs != null && rttMs > 900) -> NetworkTier.SLOW
        (kbps != null && kbps < 2000) || (rttMs != null && rttMs > 350) -> NetworkTier.MEDIUM
        else -> NetworkTier.FAST
    }

    /** One finished request. Small answers measure delay; answers of 16 KB and more measure speed. */
    fun addSample(state: QualityState, ms: Double, bytes: Double): QualityState {
        if (!(ms > 0) || !(bytes >= 0)) return state
        var rtt = state.rttMs
        var kbps = state.kbps
        if (bytes < 4096) {
            rtt = ewma(rtt, ms)
        } else if (bytes >= 16384) {
            // One round trip is subtracted so a big answer from a fast but distant server is not called slow.
            val transferMs = maxOf(20.0, ms - (rtt ?: 0.0))
            kbps = ewma(kbps, bytes * 8 / transferMs)
        }
        return QualityState(rtt, kbps, classify(rtt, kbps))
    }

    /** Time limits that fit the measured speed: a 3 KB message on EDGE must not time out. */
    fun timeoutFor(kind: RequestKind, tier: NetworkTier): Long {
        val base = when (kind) { RequestKind.UPLOAD -> 120_000L; RequestKind.SEND -> 20_000L; RequestKind.READ -> 18_000L }
        return when (tier) { NetworkTier.SLOW -> base * 3; NetworkTier.MEDIUM -> Math.round(base * 1.5); NetworkTier.FAST -> base }
    }
}

/** The live value shared by everything that makes requests. */
class NetworkQuality {
    @Volatile private var state = QualityState.START

    val tier: NetworkTier get() = state.tier
    val current: QualityState get() = state

    @Synchronized
    fun report(ms: Long, bytes: Int) {
        state = QualityRules.addSample(state, ms.toDouble(), bytes.toDouble())
    }
}
