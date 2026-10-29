package expo.modules.lineasignal

import org.json.JSONObject

/** Test-only JSON-lines driver; never included in the Android application. */
fun main() {
  generateSequence(::readLine).forEach { line ->
    try {
      val request = JSONObject(line);val args = request.getJSONArray("args")
      val result: Any = when (request.getString("method")) {
        "createState" -> SignalCore.createState(args.getString(0), args.getInt(1))
        "replenish" -> SignalCore.replenish(args.getString(0), args.getInt(1))
        "trustIdentity" -> SignalCore.trustIdentity(args.getString(0), args.getString(1), args.getInt(2), args.getString(3))
        "encrypt" -> SignalCore.encrypt(args.getString(0), args.getString(1), args.getInt(2), args.getString(3), args.optJSONObject(4)?.toMap())
        "decrypt" -> SignalCore.decrypt(args.getString(0), args.getString(1), args.getInt(2), args.getInt(3), args.getString(4))
        "seal" -> SignalCore.seal(args.getString(0), args.getString(1), args.getString(2), args.getString(3))
        "open" -> SignalCore.open(args.getString(0), args.getString(1), args.getString(2), args.getString(3))
        else -> throw SignalFailure("UNKNOWN_METHOD")
      }
      println(JSONObject(mapOf("ok" to true, "value" to result)))
    } catch (error: Exception) {
      println(JSONObject(mapOf("ok" to false, "error" to ((error as? SignalFailure)?.reason ?: "CRYPTO_FAILED"))))
    }
  }
}
