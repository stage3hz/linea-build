package com.linea.messenger.linkpreview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import android.os.Handler
import android.os.Looper
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.ConnectionSpec
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Fetches the page of a link the person has just written, to make its card.
 *
 *  Privacy first — this is the only code of the app that talks to a site the person names:
 *  - It runs on the SENDER's phone only, and only for a link typed into the composer while «Предпросмотр ссылок»
 *    is on. Our server is not involved and never learns the link; the recipient's phone never fetches anything.
 *  - `https` only, the default port only, public host names only (the shared core's `fetchable`). The addresses a
 *    name resolves to are checked by the very resolver the connection uses (`LinkDns`), so there is no moment
 *    between the check and the connection; the address really reached is checked once more before the request
 *    goes out on it. Loopback, private and link-local networks are never read from. No proxy is used: through
 *    one, the addresses could not be checked.
 *  - A client of its own that keeps nothing: no cookies, no cache, no saved passwords, no client certificates.
 *    The request says nothing about the app, the account or the device beyond what any phone browser says.
 *  - At most three redirects, each followed by hand and checked the same way; six seconds; the first 256 KiB of
 *    the page; a picture of at most 2 MiB, which is scaled down, encoded again and cleaned by the core before it
 *    goes anywhere.
 *  - A page is only read as text by the core's parser. Nothing of it is run, shown in a web view or followed.
 *  Certificates are checked by the system, as for any request. Nothing is written to logs. */
class LinkFetcher {
  private val main = Handler(Looper.getMainLooper())
  private val work = Executors.newCachedThreadPool { run -> Thread(run, "invizent.link-fetch").apply { isDaemon = true; priority = Thread.MIN_PRIORITY + 1 } }
  /** Cards made in this run of the app, by the link as written: typing on does not fetch the page again.
   *  In memory only. A page that gave no card is not remembered: it may have been the network. Main thread only. */
  private val made = LinkedHashMap<String, Map<String, Any?>>()

  /** One piece of work that can be given up. */
  class Ticket {
    @Volatile var cancelled = false
      private set
    @Volatile internal var job: LinkDownload? = null
    fun cancel() {
      cancelled = true
      job?.cancel()
    }
  }

  /** Makes the card for a link (the core's `candidate` of the composer's text). `done` comes on the main thread,
   *  with the card for `encrypt` or null. Call on the main thread. */
  fun card(context: Context, url: String, done: (Map<String, Any?>?) -> Unit): Ticket {
    val ticket = Ticket()
    if (!LinkSettings.on(context) || !LinkCore.fetchable(url)) {
      main.post { if (!ticket.cancelled) done(null) }
      return ticket
    }
    val known = made[url]
    if (known != null) {
      main.post { if (!ticket.cancelled) done(known) }
      return ticket
    }
    val limits = LinkCore.limits
    work.execute {
      val card = try { fetch(url, limits, ticket) } catch (_: Throwable) { null }
      main.post {
        ticket.job = null
        if (ticket.cancelled) return@post
        if (card != null && made[url] == null) {
          made[url] = card
          if (made.size > 24) made.remove(made.keys.first())
        }
        done(card)
      }
    }
    return ticket
  }

  /** The page, then its picture; on the fetcher's thread. */
  private fun fetch(url: String, limits: LinkCore.Limits, ticket: Ticket): Map<String, Any?>? {
    val page = LinkDownload(url, LinkDownload.Kind.PAGE, limits.htmlBytes, limits)
    ticket.job = page
    if (ticket.cancelled) return null
    val result = page.load() ?: return null
    val parsed = LinkCore.parse(result.body, result.contentType, result.finalUrl) ?: return null
    val pictureUrl = parsed.imageUrl ?: return LinkCore.wire(url, parsed.site, parsed.title, parsed.description, null)
    val picture = LinkDownload(pictureUrl, LinkDownload.Kind.PICTURE, limits.imageDownloadBytes, limits)
    ticket.job = picture
    if (ticket.cancelled) return null
    val jpeg = picture.load()?.let { LinkPicture.small(it.body, limits.imageSide, limits.imageBytes) }
    return LinkCore.wire(url, parsed.site, parsed.title, parsed.description, jpeg)
  }

  /** Forgets the cards made so far (the setting was switched off, the account was left). Main thread. */
  fun forget() { made.clear() }

  companion object {
    val shared: LinkFetcher by lazy { LinkFetcher() }
  }
}

/** The picture of a card: a downloaded file made into the small JPEG that travels. */
object LinkPicture {
  /** How a picture of this size is decoded for a card with this side: null — not at all (not a picture, a
   *  sliver, or one that claims an absurd size); else how many times smaller it is read (a power of two that
   *  still leaves `side` pixels to scale down from). */
  fun sample(width: Int, height: Int, side: Int): Int? {
    if (width <= 0 || height <= 0 || width > 12000 || height > 12000 || width.toLong() * height > 40_000_000L) return null
    // A sliver is not a picture of anything.
    if (width < 40 || height < 40) return null
    var sample = 1
    while (maxOf(width, height) / (sample * 2) >= side) sample *= 2
    return sample
  }

  /** The sides a card's picture is tried at, largest first. */
  fun edges(side: Int): List<Int> = listOf(side, side * 3 / 4, side / 2)

  /** The JPEG qualities tried for each side, best first. */
  val qualities = listOf(82, 70, 58, 46, 34)

  /** A picture's size scaled to fit `edge` a side (never made larger). */
  fun fitted(width: Int, height: Int, edge: Int): Pair<Int, Int> {
    val longest = maxOf(width, height)
    if (longest <= edge) return Pair(width, height)
    return Pair(maxOf(1, Math.round(width.toFloat() * edge / longest)), maxOf(1, Math.round(height.toFloat() * edge / longest)))
  }

  /** A downloaded picture as the small JPEG a card carries: at most `side` pixels a side and `bytes` bytes.
   *  The file is never decoded at its full size, and one that claims an absurd size is not decoded at all. */
  fun small(data: ByteArray, side: Int, bytes: Int): ByteArray? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    val sample = sample(bounds.outWidth, bounds.outHeight, side) ?: return null
    val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val decoded = try { BitmapFactory.decodeByteArray(data, 0, data.size, options) } catch (_: Throwable) { null } ?: return null
    // The way up the camera wrote beside the pixels is applied to the pixels: the note itself does not travel.
    val turn = Matrix()
    when (try { ExifInterface(ByteArrayInputStream(data)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> turn.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> turn.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> turn.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { turn.setRotate(90f); turn.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> turn.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { turn.setRotate(270f); turn.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> turn.setRotate(270f)
    }
    val upright = try { if (turn.isIdentity) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, turn, true) } catch (_: Throwable) { null } ?: return null
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    for (edge in edges(side)) {
      val (width, height) = fitted(upright.width, upright.height, edge)
      if (width < 1 || height < 1 || width > side || height > side) return null
      // Drawn anew on white (a JPEG has no transparency): nothing of the original file but its pixels goes on.
      val flat = try { Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888) } catch (_: Throwable) { null } ?: return null
      val canvas = Canvas(flat)
      canvas.drawColor(Color.WHITE)
      canvas.drawBitmap(upright, null, RectF(0f, 0f, width.toFloat(), height.toFloat()), paint)
      for (quality in qualities) {
        val out = ByteArrayOutputStream()
        if (flat.compress(Bitmap.CompressFormat.JPEG, quality, out) && out.size() <= bytes - 512) return out.toByteArray()
      }
    }
    return null
  }
}

/** The resolver of the fetcher's connections: the system's own answers, refused as a whole when any address of
 *  the name is on a private, loopback or link-local network (the core's `privateAddress`). The connection is made
 *  to the addresses this gives and to no others, so a name cannot answer differently between check and use. */
object LinkDns : Dns {
  /** Whether a name with these addresses may be contacted: it has some, and none of them is private. */
  fun public(addresses: List<String>, private: (String) -> Boolean = { LinkCore.privateAddress(it) }): Boolean =
    addresses.isNotEmpty() && addresses.none { it.isEmpty() || private(it) }

  override fun lookup(hostname: String): List<InetAddress> {
    val found = Dns.SYSTEM.lookup(hostname)
    // The words of the refusal name nothing: not the host, not the address.
    if (!public(found.map { it.hostAddress ?: "" })) throw UnknownHostException("refused")
    return found
  }
}

/** One download: the start of a page, or a picture. Lives for one request and its redirects. */
class LinkDownload(private val url: String, private val kind: Kind, private val cap: Int, private val limits: LinkCore.Limits) {
  enum class Kind { PAGE, PICTURE }

  class Loaded(
    val body: ByteArray, val contentType: String?,
    /** The address the answer finally came from, after redirects. */
    val finalUrl: String,
  )

  @Volatile private var cancelled = false
  @Volatile private var call: Call? = null

  /** Any thread. */
  fun cancel() {
    cancelled = true
    call?.cancel()
  }

  /** The answer, or null. Blocks: on the fetcher's thread only. */
  fun load(): Loaded? {
    // Six seconds for the whole of it, redirects included.
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(limits.timeoutMs)
    var address = allowed(url) ?: return null
    var redirects = 0
    while (true) {
      val left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
      if (cancelled || left <= 0) return null
      val request = Request.Builder().url(address).get()
        .header("User-Agent", LinkFetcherAgent.words)
        .header("Accept", accept(kind))
        .header("Accept-Language", "ru,en;q=0.8")
        .build()
      val call = client.newCall(request)
      call.timeout().timeout(left, TimeUnit.MILLISECONDS)
      this.call = call
      if (cancelled) { call.cancel(); return null }
      try {
        call.execute().use { answer ->
          val status = answer.code
          if (status in redirectCodes) {
            redirects += 1
            // Not followed: the answer is the redirect itself, which is no page.
            if (redirects > limits.redirects) return null
            val target = answer.header("Location")?.let { address.resolve(it) } ?: return null
            address = allowed(target.toString()) ?: return null
            return@use
          }
          if (status !in 200..299 || !answer.request.url.isHttps) return null
          val type = answer.header("Content-Type")
          if (!fits(kind, type)) return null
          val source = answer.body ?: return null
          // A picture that says it is larger than the limit is not started.
          if (kind == Kind.PICTURE && source.contentLength() > cap) return null
          val body = read(source.byteStream(), kind, cap) ?: return null
          if (body.isEmpty() || cancelled) return null
          return Loaded(body, type, address.toString())
        }
      } catch (_: IOException) {
        return null
      } catch (_: RuntimeException) {
        return null
      }
    }
  }

  companion object {
    private val redirectCodes = setOf(301, 302, 303, 307, 308)

    /** A client for nothing but this: TLS only, certificates checked by the system (nothing here touches that),
     *  no cookies, no cache, no answer to any request for a password, no proxy, redirects never followed by the
     *  client itself, the request never sent twice, connections not kept for later. */
    val client: OkHttpClient by lazy { OkHttpClient.Builder()
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
      .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
      .followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .cookieJar(CookieJar.NO_COOKIES)
      .cache(null)
      .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
      .proxy(Proxy.NO_PROXY)
      .dns(LinkDns)
      .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
      .addNetworkInterceptor(Interceptor { chain ->
        // The address that was really reached: nothing is asked of a private network, whatever led there.
        val reached = chain.connection()?.route()?.socketAddress?.address?.hostAddress
        if (reached == null || LinkCore.privateAddress(reached)) throw IOException("refused")
        if (!chain.request().isHttps) throw IOException("refused")
        chain.proceed(chain.request())
      })
      .build() }

    /** An address that may be contacted, as the client will read it: the core's rules for the address as written
     *  and for the address as the client understands it (the two must not disagree about where it leads). */
    fun allowed(url: String): HttpUrl? {
      if (!LinkCore.fetchable(url)) return null
      val address = url.toHttpUrlOrNull() ?: return null
      if (!address.isHttps || address.port != 443 || address.username.isNotEmpty() || address.password.isNotEmpty()) return null
      if (!LinkCore.fetchable(address.toString())) return null
      return address
    }

    fun accept(kind: Kind): String = when (kind) {
      Kind.PAGE -> "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
      Kind.PICTURE -> "image/jpeg,image/png,image/webp,image/*;q=0.8"
    }

    /** Whether an answer of this type is what was asked for: a page (or an answer that names no type), a picture
     *  that is not a drawing with code in it. */
    fun fits(kind: Kind, contentType: String?): Boolean {
      val type = (contentType ?: "").trim().lowercase()
      return when (kind) {
        Kind.PAGE -> type.isEmpty() || type.startsWith("text/html") || type.startsWith("application/xhtml+xml")
        Kind.PICTURE -> type.startsWith("image/") && !type.startsWith("image/svg")
      }
    }

    /** Reads an answer's body within `cap` bytes. The head of a page is in its first kilobytes: the rest is not
     *  needed and not read. A picture longer than the limit is no picture: null. */
    fun read(stream: java.io.InputStream, kind: Kind, cap: Int): ByteArray? {
      val out = ByteArrayOutputStream()
      val buffer = ByteArray(16 * 1024)
      while (true) {
        val room = cap - out.size()
        if (room <= 0) {
          if (kind == Kind.PAGE) return out.toByteArray()
          return if (stream.read() < 0) out.toByteArray() else null
        }
        val count = stream.read(buffer, 0, minOf(buffer.size, room))
        if (count < 0) return out.toByteArray()
        out.write(buffer, 0, count)
      }
    }
  }
}

/** The words of the `User-Agent` header: what any phone browser says — no app name, no version of ours, no
 *  account, no device model. */
object LinkFetcherAgent {
  const val words = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
}
