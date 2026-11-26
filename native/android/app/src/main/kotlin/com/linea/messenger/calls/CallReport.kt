package com.linea.messenger.calls

/** What one call went through, told in a single grey line under its last words — in the preview build only
 *  (`com.linea.messenger.preview`, the one the owner tests on his phones), so that a call that did not come up can
 *  be explained from a picture of the screen, without a cable. The iPhone keeps the very same fields
 *  (CallReport.swift), so pictures of both phones can be laid side by side.
 *
 *  Only states, counts, yes/no and seconds: never an SDP, an address, a key, a token, a name or a message. The
 *  addresses are counted by their kind and are never kept. */
class CallReport(val incoming: Boolean) {
  private val began = System.currentTimeMillis()
  /** How many servers the call was given, and where they came from: «сервер», «повтор» (the second ask),
   *  «прошлые» (the last call's), «публичные» (the public finder alone). */
  var servers = 0
  var source = "—"
  /** A relay is among the servers; its address was gathered. */
  var wantRelay = false
  var relayFound = false
  /** How long the addresses were waited for, and whether the gathering said it was complete. */
  var gatherMs: Long? = null
  var gatherComplete = false
  /** This phone's own addresses as they went out inside its SDP (see `counts`). */
  var own = "—"
  /** The answer: «нет» (none yet), «сделан», «отправлен», «не отправлен», «не сделан»; on the caller's
   *  side «получен» or «не принят» (the connection refused it). */
  var answer = "нет"
  /** The connection's last state as it said it ("new", "connecting", "connected", "failed"…): it waits for both
   *  the addresses (ICE) and the handshake of the keys (DTLS), and is what moves the call to its clock. */
  var state = "—"
  /** Its two parts on their own, Android only for now: ICE as the connection says it, and the DTLS handshake as
   *  its statistics say it ("new", "connecting", "connected", "failed"). «ICE: connecting (ice connected, dtls
   *  connecting)» is a call whose addresses answer but whose keys were never agreed. */
  var ice = "—"
  var dtls = "—"
  /** What moved the call to its clock: «состояние» (the connection said "connected") or «звук» (the other side's
   *  sound was already arriving while the connection had not said so), and when, from «Соединение…». */
  var upBy = ""
  var upAt: Long? = null
  /** The servers that refused or did not answer, without their addresses («turn udp 401», «stun 701»). */
  val serverTrouble = LinkedHashSet<String>()
  /** The kind of network the phone was on when the call began: «wifi», «cellular»… */
  var network = "?"
  /** When the offer was made (the caller: sent; the callee: the message's time) and when the answer went or came. */
  var offerAt: Long? = null
  var answerAt: Long? = null
  /** When the call started saying «Соединение…». */
  var connectingAt: Long? = null
  /** What ended the call, in a word or two («ICE failed», «60 с», «собеседник: …», «кнопка»…). */
  var cause = ""

  /** The line itself, at the end of the call; `theirs`: the other side's SDP as this phone has it. */
  fun line(theirs: String?): String {
    val now = System.currentTimeMillis()
    val relay = if (!wantRelay) "не настроен" else if (relayFound) "да" else "нет"
    val parts = ArrayList<String>()
    parts.add("ICE: $state (ice $ice, dtls $dtls)")
    val up = upAt
    if (upBy.isNotEmpty() && up != null) parts.add("вверх: $upBy через ${seconds(up - (connectingAt ?: began))} с")
    parts.add("relay: $relay")
    parts.add("серверов: $servers ($source)")
    parts.add("ответ: $answer")
    val offer = offerAt; val answered = answerAt
    if (offer != null && answered != null) parts.add("ответ через ${seconds(answered - offer)} с")
    gatherMs?.let { parts.add("сбор: ${seconds(it)} с" + if (gatherComplete) "" else " (не весь)") }
    parts.add("кандидаты: свои $own · чужие ${if (theirs.isNullOrEmpty()) "—" else counts(theirs)}")
    if (serverTrouble.isNotEmpty()) parts.add("серверы: " + serverTrouble.take(4).joinToString(", "))
    parts.add("сеть: $network")
    if (cause.isNotEmpty()) parts.add("конец: $cause")
    parts.add("${seconds(now - (connectingAt ?: began))} с")
    return parts.joinToString(" · ")
  }

  companion object {
    /** Whether this build shows the line: the preview one only, never the store's. */
    fun shown(packageName: String?): Boolean = packageName == "com.linea.messenger.preview"

    /** A server's refusal in words without its address: the kind of server and how it is reached («turn udp»,
     *  «turns tcp», «stun»), and the error's number (401: the password was not taken; 701: no answer). Nothing
     *  else of the server's address is kept. */
    fun troubleWords(url: String?, code: Int): String? {
      val address = url?.trim()?.lowercase() ?: return null
      val scheme = address.substringBefore(':', "").takeIf { it == "turn" || it == "turns" || it == "stun" || it == "stuns" } ?: return null
      val transport = address.substringAfter("transport=", "").takeWhile { it.isLetter() }.takeIf { it == "udp" || it == "tcp" }
        ?: if (scheme == "turns") "tcp" else if (scheme == "turn") "udp" else ""
      return listOf(scheme, transport, if (code > 0) code.toString() else "").filter { it.isNotEmpty() }.joinToString(" ")
    }

    private fun seconds(ms: Long): String = if (ms < 10_000) String.format(java.util.Locale.ROOT, "%.1f", ms / 1000.0) else (ms / 1000).toString()

    /** The addresses inside an SDP counted by kind: «h2 s1 r0», with how many of the host ones are IPv6 or a
     *  hidden `.local` name, and «p» for peer-reflexive ones when there are any. Nothing of the address itself is
     *  kept: only the kind and those two yes/no questions. */
    fun counts(sdp: String): String {
      var host = 0; var srflx = 0; var relay = 0; var prflx = 0; var v6 = 0; var mdns = 0; var tcp = 0
      for (raw in sdp.split('\n')) {
        val line = raw.trim()
        if (!line.startsWith("a=candidate:")) continue
        val fields = line.split(' ')
        val at = fields.indexOf("typ")
        if (at < 0 || at + 1 >= fields.size) continue
        if (fields.size > 2 && fields[2].equals("tcp", ignoreCase = true)) tcp += 1
        when (fields[at + 1]) {
          "host" -> {
            host += 1
            val address = if (fields.size > 4) fields[4] else ""
            if (address.endsWith(".local")) mdns += 1 else if (address.contains(':')) v6 += 1
          }
          "srflx" -> srflx += 1
          "relay" -> relay += 1
          "prflx" -> prflx += 1
        }
      }
      val extra = ArrayList<String>()
      if (v6 > 0) extra.add("v6 $v6")
      if (mdns > 0) extra.add(".local $mdns")
      var words = "h$host" + (if (extra.isEmpty()) "" else " (${extra.joinToString(", ")})") + " s$srflx r$relay"
      if (prflx > 0) words += " p$prflx"
      if (tcp > 0) words += " tcp $tcp"
      return words
    }
  }
}
