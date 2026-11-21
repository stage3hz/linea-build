package com.linea.messenger.linkpreview

import java.util.Base64
import com.linea.messenger.core.Core

/** The shared core's part about the cards of links (native/core/src/link_preview.rs), as Kotlin sees it: which
 *  link of a text gets a card, whether an address may be fetched at all, what a fetched page says, and the card
 *  as it travels inside an encrypted message. The rules are the core's; nothing here decides anything.
 *  The function on the core's side is in native/core/src/jni.rs (`…_linkpreview_LinkCore_linkCall`). */
object LinkCore {
  /** What a fetched page says about itself. */
  class Page(val site: String, val title: String, val description: String, val imageUrl: String?)

  /** What this phone keeps to when it fetches a page for a card. */
  data class Limits(
    val htmlBytes: Int = 256 * 1024,
    val imageDownloadBytes: Int = 2 * 1024 * 1024,
    val imageBytes: Int = 24 * 1024,
    val imageSide: Int = 480,
    val redirects: Int = 3,
    val timeoutMs: Long = 6000,
  )

  /** `invizent_link_call`: `argsJson` is a JSON array, the answer JSON. */
  @JvmStatic external fun linkCall(name: String, argsJson: String): String?

  /** One of the core's link functions by name (see `invizent_link_call`); null when it has no answer (or the
   *  library is missing, or is an older one without it). */
  fun call(name: String, args: List<Any?> = emptyList()): Any? {
    if (!Core.loaded) return null
    val argsText = Core.text(args) ?: return null
    return try { Core.value(linkCall(name, argsText)) } catch (_: UnsatisfiedLinkError) { null }
  }

  /** The limits as the core names them; a number it does not give stays as written above. */
  fun limits(made: Map<String, Any?>?): Limits {
    val base = Limits()
    if (made == null) return base
    fun whole(key: String): Long? = (made[key] as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= Int.MAX_VALUE }?.toLong()
    return Limits(
      htmlBytes = whole("htmlBytes")?.takeIf { it > 0 }?.toInt() ?: base.htmlBytes,
      imageDownloadBytes = whole("imageDownloadBytes")?.takeIf { it > 0 }?.toInt() ?: base.imageDownloadBytes,
      imageBytes = whole("imageBytes")?.takeIf { it > 0 }?.toInt() ?: base.imageBytes,
      imageSide = whole("imageSide")?.takeIf { it > 0 }?.toInt() ?: base.imageSide,
      redirects = whole("redirects")?.toInt() ?: base.redirects,
      timeoutMs = whole("timeoutMs")?.takeIf { it > 0 } ?: base.timeoutMs,
    )
  }

  val limits: Limits by lazy { limits(Core.map(call("limits"))) }

  /** The link of a text that gets the card: its first `https` link, when it may be fetched. Null: no card. */
  fun candidate(text: String): String? = call("candidate", listOf(text, null)) as? String

  /** Whether this phone may fetch the address: `https`, the default port, a public host name. */
  fun fetchable(url: String): Boolean = call("fetchable", listOf(url)) as? Boolean ?: false

  /** Whether an address a host name resolved to must NOT be contacted (loopback, private, link-local…).
   *  Without an answer the address is not contacted. */
  fun privateAddress(ip: String): Boolean = call("privateAddress", listOf(ip)) as? Boolean ?: true

  private fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

  /** The head of a fetched page; null when the page's address is not one a card may come from. */
  fun parse(html: ByteArray, contentType: String?, pageUrl: String): Page? {
    val made = Core.map(call("parse", listOf(base64(html), contentType, pageUrl))) ?: return null
    return Page(made["site"] as? String ?: "", made["title"] as? String ?: "", made["description"] as? String ?: "", made["imageUrl"] as? String)
  }

  /** The card's picture (a JPEG this phone has just encoded) cleaned of everything but the picture:
   *  `{mimeType, base64, width, height}`; null when it is not acceptable. */
  fun image(jpeg: ByteArray): Map<String, Any?>? = Core.map(call("image", listOf(base64(jpeg))))

  /** The card for the encryption service's `encrypt`: the texts made plain and cut to their limits, the picture
   *  (a JPEG this phone has just encoded) cleaned of everything but the picture. Null: nothing to show. */
  fun wire(url: String, site: String, title: String, description: String, jpeg: ByteArray?): Map<String, Any?>? =
    Core.map(call("wire", listOf(url, site, title, description, jpeg?.let { base64(it) })))

  /** Whether a card is one a message with this text may carry. */
  fun valid(card: Map<String, Any?>, text: String, entities: Any? = null): Boolean = call("valid", listOf(card, text, entities)) as? Boolean ?: false
}
