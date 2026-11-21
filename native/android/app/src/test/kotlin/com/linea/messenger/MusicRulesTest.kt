package com.linea.messenger

import com.linea.messenger.core.Core
import com.linea.messenger.music.CoverTint
import com.linea.messenger.music.MusicCatalog
import com.linea.messenger.music.MusicFailure
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.music.MusicTrack
import com.linea.messenger.music.MusicWords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules of «Музыка» that need no phone: who may listen to a track (unknown flags fail closed), what a
 *  catalogue's answer becomes, which addresses are taken, the bar's light from a cover, the words of the page.
 *  Audius is never contacted: the samples are written by hand in the shape mobile/src/music/catalog.ts reads. */
class MusicRulesTest {
  /** A track of Audius that anyone may listen to and download. */
  private fun sample(id: String = "D7KyD", edit: (MutableMap<String, Any?>) -> Unit = {}): Map<String, Any?> {
    val raw = Core.map(Core.value("""{
      "id":"$id","title":"  Северное\u0007 сияние ","permalink":"/lera/severnoe-siyanie","duration":214.4,"genre":"Electronic","mood":"Peaceful",
      "user":{"name":"Лера Туман","handle":"lera"},
      "artwork":{"150x150":"https://creatornode.audius.co/content/abc/150x150.jpg","480x480":"https://creatornode.audius.co/content/abc/480x480.jpg","1000x1000":"https://creatornode.audius.co/content/abc/1000x1000.jpg"},
      "is_available":true,"is_streamable":true,"is_delete":false,"is_unlisted":false,"is_stream_gated":false,"stream_conditions":null,
      "access":{"stream":true,"download":true},
      "stream":{"url":"https://creatornode.audius.co/tracks/cidstream/abc?signature=x"},
      "is_downloadable":true,"is_download_gated":false,"download_conditions":null,
      "download":{"url":"https://creatornode.audius.co/tracks/cidstream/abc?filename=a.mp3"}
    }"""))!!.toMutableMap()
    edit(raw)
    return raw
  }

  @Test fun aPublicTrackIsShownWithItsAuthorAndItsPage() {
    val track = MusicCatalog.normalize(sample())!!
    assertEquals("audius:D7KyD", track.id)
    assertEquals("audius", track.source)
    assertEquals("D7KyD", track.sourceId)
    // Control characters are taken out, the ends are trimmed, the length is whole seconds.
    assertEquals("Северное сияние", track.title)
    assertEquals("Лера Туман", track.artist)
    assertEquals(214.0, track.duration, 0.0)
    assertEquals("https://creatornode.audius.co/content/abc/480x480.jpg", track.artworkUrl)
    assertEquals("https://audius.co/lera/severnoe-siyanie", track.sourceUrl)
    assertEquals("Peaceful", track.mood)
    assertTrue(track.downloadable)
    // The author's handle stands in for a missing name; a smaller cover for a missing one.
    assertEquals("lera", MusicCatalog.normalize(sample { it["user"] = mapOf("handle" to "lera") })!!.artist)
    assertEquals("https://creatornode.audius.co/content/abc/150x150.jpg", MusicCatalog.normalize(sample { it["artwork"] = mapOf("150x150" to "https://creatornode.audius.co/content/abc/150x150.jpg") })!!.artworkUrl)
    assertNull(MusicCatalog.normalize(sample { it["artwork"] = mapOf("480x480" to "http://creatornode.audius.co/a.jpg") })!!.artworkUrl)
    // No title, no author or no page of its own: not shown.
    assertNull(MusicCatalog.normalize(sample { it["title"] = "  " }))
    assertNull(MusicCatalog.normalize(sample { it["user"] = emptyMap<String, Any?>() }))
    for (link in listOf(null, "", "//evil.example/a/b", "https://evil.example/a/b", "/only-one", "/a/b/c", "/a/b?x=1", "/a/b#x", "javascript:alert(1)")) {
      assertNull("$link", MusicCatalog.normalize(sample { it["permalink"] = link }))
    }
    assertEquals("https://audius.co/lera/track/", MusicCatalog.normalize(sample { it["permalink"] = "https://audius.co/lera/track/" })!!.sourceUrl)
  }

  @Test fun unknownAccessFlagsFailClosed() {
    assertTrue(MusicCatalog.canStream(sample()))
    val closed: List<(MutableMap<String, Any?>) -> Unit> = listOf(
      { it["id"] = "not an id!" }, { it["id"] = 7.0 },
      { it["is_available"] = false }, { it.remove("is_available") }, { it["is_available"] = "true" },
      { it["is_streamable"] = false }, { it.remove("is_streamable") },
      { it["is_delete"] = true }, { it.remove("is_delete") },
      { it["is_unlisted"] = true }, { it.remove("is_unlisted") },
      { it["is_stream_gated"] = true }, { it.remove("is_stream_gated") },
      { it["access"] = mapOf("stream" to false, "download" to true) }, { it.remove("access") }, { it["access"] = mapOf("stream" to 1.0) },
      // A present allowlist, even an empty one, is not permission for an anonymous app.
      { it["allowed_api_keys"] = emptyList<String>() }, { it["allowed_api_keys"] = listOf("key") },
      { it["access_authorities"] = listOf("0xabc") }, { it["access_authorities"] = "all" },
      { it["stream_conditions"] = mapOf("usdc_purchase" to mapOf("price" to 100.0)) }, { it["stream_conditions"] = "none" },
      { it.remove("stream") }, { it["stream"] = mapOf("url" to "http://creatornode.audius.co/a") }, { it["stream"] = mapOf("url" to "https://127.0.0.1/a") },
    )
    closed.forEachIndexed { index, edit ->
      assertFalse("case $index", MusicCatalog.canStream(sample(edit = edit)))
      assertNull("case $index", MusicCatalog.normalize(sample(edit = edit)))
    }
    // What says «open to all» in so many words is open.
    assertTrue(MusicCatalog.canStream(sample { it["access_authorities"] = emptyList<String>(); it["stream_conditions"] = emptyMap<String, Any?>(); it["allowed_api_keys"] = null }))
    assertFalse(MusicCatalog.canStream(null))
    assertFalse(MusicCatalog.canStream(listOf(sample())))
  }

  @Test fun downloadingIsTheAuthorsOwnChoice() {
    assertTrue(MusicCatalog.canDownload(sample()))
    val closed: List<(MutableMap<String, Any?>) -> Unit> = listOf(
      { it["is_downloadable"] = false }, { it.remove("is_downloadable") },
      { it["is_download_gated"] = true }, { it.remove("is_download_gated") },
      { it["access"] = mapOf("stream" to true, "download" to false) }, { it["access"] = mapOf("stream" to true) },
      { it["download_conditions"] = mapOf("follow_user_id" to 1.0) },
      { it.remove("download") }, { it["download"] = mapOf("url" to "ftp://creatornode.audius.co/a") },
      // What may not be listened to may not be downloaded either.
      { it["is_stream_gated"] = true },
    )
    closed.forEachIndexed { index, edit -> assertFalse("case $index", MusicCatalog.canDownload(sample(edit = edit))) }
    // The older name of the flag is read when the newer one is absent — and only then.
    assertTrue(MusicCatalog.canDownload(sample { it.remove("is_downloadable"); it["downloadable"] = true }))
    assertFalse(MusicCatalog.canDownload(sample { it["is_downloadable"] = false; it["downloadable"] = true }))
    // A track that may be heard but not downloaded is shown, without the download.
    assertFalse(MusicCatalog.normalize(sample { it["is_downloadable"] = false })!!.downloadable)
  }

  @Test fun aPageOfTheCatalogue() {
    val page = MusicCatalog.page(listOf(sample("a1"), sample("a2") { it["is_stream_gated"] = true }, sample("a1"), "not a track", sample("a3")), offset = 24, limit = 5)
    // Closed tracks and repeats are left out; a full page says there is a next one, counted by what was asked.
    assertEquals(listOf("audius:a1", "audius:a3"), page.tracks.map { it.id })
    assertEquals(29, page.nextOffset)
    assertNull(MusicCatalog.page(listOf(sample("a1")), offset = 0, limit = 24).nextOffset)
    // A full page of closed tracks does not end the pages.
    val closed = MusicCatalog.page((1..3).map { index -> sample("b$index") { it["is_unlisted"] = true } }, offset = 0, limit = 3)
    assertTrue(closed.tracks.isEmpty())
    assertEquals(3, closed.nextOffset)
    val failure = try { MusicCatalog.page(mapOf("data" to 1.0), 0, 24); null } catch (failed: MusicFailure) { failed }
    assertEquals("Сервис музыки вернул неверный ответ. Попробуйте позже.", failure?.words)
    // The answer about one track must be about that very track.
    assertNotNull(MusicCatalog.freshTrack(mapOf("data" to sample("a1")), "a1"))
    assertNull(MusicCatalog.freshTrack(mapOf("data" to sample("a2")), "a1"))
    assertNull(MusicCatalog.freshTrack(mapOf("data" to listOf(sample("a1"))), "a1"))
  }

  @Test fun onlyPlainHttpsAddressesOfPublicNamesAreTaken() {
    for (good in listOf("https://creatornode.audius.co/a?b=c", "HTTPS://cdn.example.org", "https://a-b.example.org:443/x", "https://audius.co/")) assertEquals(good, MusicCatalog.safeHttpsUrl(good))
    val bad = listOf(null, 5.0, "", "http://example.org/a", "ftp://example.org", "//example.org/a", "example.org/a", "https://", "https:///a",
      "https://user@example.org/a", "https://user:pass@example.org/a", "https://example.org/a#frag", "https://example.org:8443/a", "https://example.org:80/a",
      "https://localhost/a", "https://example/a", "https://192.168.1.10/a", "https://127.1/a", "https://0x7f.0.0.1/a", "https://2130706433/a", "https://[::1]/a", "https://example.org./a",
      "https://router.lan/a", "https://printer.local/a", "https://svc.internal/a", "https://a.test/a", "https://abc.onion/a", "https://-bad.example.org/a", "https://bad_.example.org/a",
      "https://exa mple.org/a", "https://example.org/a b", "https://example.org/a\\b", "https://example.org/\u0001", "https://пример.рф/a", "https://example.org%2e/a", "https://a." + "b".repeat(64) + ".org/")
    for (address in bad) assertNull("$address", MusicCatalog.safeHttpsUrl(address))
    assertNull(MusicCatalog.safeHttpsUrl("https://example.org/" + "a".repeat(16400)))
  }

  @Test fun whatIsAskedOfAudius() {
    assertEquals("/tracks/trending?offset=0&limit=24&time=week", MusicCatalog.searchPath("  ", null, 0, 24))
    assertEquals("/tracks/search?offset=24&limit=24&query=%D1%82%D0%B8%D1%85%D0%B8%D0%B9%20%D1%87%D0%B0%D1%81%20%26%20co&sort_method=relevant&includePurchaseable=false", MusicCatalog.searchPath(" тихий час & co ", null, 24, 24))
    // A mood is known by its own id or by the catalogue's word for it; anything else is no mood.
    assertEquals("/tracks/search?offset=0&limit=24&mood=Peaceful&sort_method=popular&includePurchaseable=false", MusicCatalog.searchPath("", "Peaceful", 0, 24))
    assertEquals("/tracks/search?offset=0&limit=24&mood=Energizing&sort_method=popular&includePurchaseable=false", MusicCatalog.searchPath("", "energy", 0, 24))
    assertEquals("/tracks/trending?offset=0&limit=24&time=week", MusicCatalog.searchPath("", "Angry&x=1", 0, 24))
    assertEquals("/tracks/trending?offset=0&limit=24&time=week", MusicCatalog.searchPath("", "all", 0, 24))
    assertEquals(160, MusicCatalog.searchPath("я".repeat(300), null, 0, 24).substringAfter("query=").substringBefore("&").length / 6)
    assertEquals(listOf("Всё", "Спокойно", "Энергия", "Фокус", "Настроение", "Романтика", "Меланхолия"), MusicCatalog.moods.map { it.label })
  }

  @Test fun whatAnAnswerOfAudiusMeans() {
    fun words(status: Int, body: String? = "{}") = (MusicCatalog.readAnswer(status, body?.toByteArray()).exceptionOrNull() as? MusicFailure)
    assertEquals(mapOf("data" to listOf(1.0)), MusicCatalog.readAnswer(200, """{"data":[1]}""".toByteArray()).getOrNull())
    assertEquals("Audius временно ограничил запросы. Подождите немного и попробуйте снова.", words(429)?.words)
    assertEquals("Эта музыка сейчас недоступна через Audius.", words(403)?.words)
    assertEquals("Эта музыка сейчас недоступна через Audius.", words(401)?.words)
    assertEquals("Трек больше недоступен в Audius.", words(404)?.words)
    assertEquals("Сервис музыки временно недоступен. Попробуйте позже.", words(503)?.words)
    // Only a failure of the service itself is worth one more try.
    assertTrue(words(503)!!.retryable)
    assertFalse(words(400)!!.retryable || words(429)!!.retryable || words(404)!!.retryable)
    // A redirect is never followed: it is simply not an answer.
    assertEquals("Сервис музыки временно недоступен. Попробуйте позже.", words(302)?.words)
    assertEquals("Сервис музыки вернул слишком большой ответ.", words(200, null)?.words)
    assertEquals("Не удалось прочитать ответ Audius. Попробуйте позже.", words(200, "<html>")?.words)
    assertEquals("Не удалось прочитать ответ Audius. Попробуйте позже.", words(200, "[1]")?.words)
  }

  @Test fun soundCloudThroughThePersonsServer() {
    val track = MusicCatalog.soundCloudTrack(Core.value("""{"source":"soundcloud","sourceId":"soundcloud:tracks:123456","title":"Тихий час","artist":"Миша Ветров",
      "artworkUrl":"https://i1.sndcdn.com/artworks-000-t500x500.jpg","duration":243,"genre":"Ambient","sourceUrl":"https://soundcloud.com/misha/quiet","downloadable":true}"""))!!
    assertEquals("sc:soundcloud:tracks:123456", track.id)
    assertEquals("soundcloud:tracks:123456", track.sourceId)
    assertEquals(243.0, track.duration, 0.0)
    assertEquals("https://soundcloud.com/misha/quiet", track.sourceUrl)
    // Nothing of SoundCloud is ever offered for download.
    assertFalse(track.downloadable)
    assertNull(MusicCatalog.soundCloudTrack(mapOf("source" to "audius", "sourceId" to "soundcloud:tracks:1", "title" to "a", "artist" to "b")))
    assertNull(MusicCatalog.soundCloudTrack(mapOf("source" to "soundcloud", "sourceId" to "soundcloud:tracks:1/../2", "title" to "a", "artist" to "b")))
    assertNull(MusicCatalog.soundCloudTrack(mapOf("source" to "soundcloud", "sourceId" to "soundcloud:tracks:1", "title" to "a")))
    val plain = MusicCatalog.soundCloudTrack(mapOf("source" to "soundcloud", "sourceId" to "soundcloud:tracks:1", "title" to "a".repeat(300), "artist" to "b", "artworkUrl" to "http://i1.sndcdn.com/a.jpg", "duration" to -5.0))!!
    assertEquals(200, plain.title.length)
    assertNull(plain.artworkUrl)
    assertEquals(0.0, plain.duration, 0.0)
    assertTrue(MusicCatalog.isSoundCloudUrn("soundcloud:tracks:1"))
    for (wrong in listOf("soundcloud:tracks:", "soundcloud:users:1", "soundcloud:tracks:1x", "soundcloud:tracks:" + "1".repeat(21), 1.0, null)) assertFalse("$wrong", MusicCatalog.isSoundCloudUrn(wrong))
    val page = MusicCatalog.soundCloudPage(mapOf("tracks" to listOf(mapOf("source" to "soundcloud", "sourceId" to "soundcloud:tracks:1", "title" to "a", "artist" to "b"), "x", mapOf("source" to "other")), "nextOffset" to 24.0))
    assertEquals(1, page.tracks.size)
    assertEquals(24, page.nextOffset)
    assertNull(MusicCatalog.soundCloudPage(mapOf("tracks" to "none")).nextOffset)
  }

  @Test fun theLightOfACover() {
    // The same answers as `vividTint` of the reference gives (worked out with its own code).
    assertEquals("#12d9b1", CoverTint.vivid(14, 124, 102))
    assertEquals("#ed4f22", CoverTint.vivid(224, 86, 47))
    assertEquals("#2254ed", CoverTint.vivid(47, 91, 224))
    assertEquals("#f0dd4c", CoverTint.vivid(242, 226, 107))
    assertEquals("#121cd9", CoverTint.vivid(10, 20, 200))
    // Black, white and grey have no colour of their own.
    for (grey in listOf(Triple(201, 201, 201), Triple(0, 0, 0), Triple(255, 255, 255), Triple(120, 110, 112))) assertEquals("", CoverTint.vivid(grey.first, grey.second, grey.third))
    assertEquals(listOf("#12d9b1", "#ed4f22", "#2254ed"), CoverTint.glowOf(listOf(Triple(14, 124, 102), Triple(224, 86, 47), Triple(47, 91, 224))))
    // A grey part takes the first colour there is; a cover without any colour has no light at all.
    assertEquals(listOf("#ed4f22", "#ed4f22", "#2254ed"), CoverTint.glowOf(listOf(Triple(200, 200, 200), Triple(224, 86, 47), Triple(47, 91, 224))))
    assertNull(CoverTint.glowOf(listOf(Triple(201, 201, 201), Triple(110, 110, 110), Triple(42, 42, 42))))
    assertNull(CoverTint.glowOf(listOf(Triple(14, 124, 102))))
  }

  @Test fun aCoverIsReadAtThreePlaces() {
    // Six columns, two rows: red, red | green, blue (their average) | white, black.
    val red = 0xFFFF0000.toInt(); val green = 0xFF00FF00.toInt(); val blue = 0xFF0000FF.toInt(); val white = 0xFFFFFFFF.toInt(); val black = 0xFF000000.toInt()
    val line = intArrayOf(red, red, green, blue, white, black)
    assertEquals(listOf(Triple(255, 0, 0), Triple(0, 128, 128), Triple(128, 128, 128)), CoverTint.row(line + line, 6, 2))
    assertNull(CoverTint.row(intArrayOf(red, green), 2, 1))
    assertNull(CoverTint.row(intArrayOf(red, green, blue), 3, 2))
  }

  @Test fun rememberedLightsAreReadInTheReferencesForm() {
    val known = CoverTint.parse("""{"audius:a":["#12d9b1","#ed4f22","#2254ed"],"audius:grey":null,"audius:bad":["#12d9b1","red","#2254ed"],"audius:short":["#12d9b1"],"audius:odd":["#12d9b1","#ed4f22","#2254ed",7]}""")
    assertEquals(listOf("#12d9b1", "#ed4f22", "#2254ed"), known["audius:a"])
    // «No colour» is an answer too; whatever is not three colours reads as none.
    for (id in listOf("audius:grey", "audius:bad", "audius:short", "audius:odd")) assertEquals(id, emptyList<String>(), known[id])
    assertTrue(CoverTint.parse(null).isEmpty() && CoverTint.parse("[]").isEmpty() && CoverTint.parse("не JSON").isEmpty())
  }

  @Test fun theLibraryAsItIsKept() {
    val kept = MusicPlayer.track(Core.value("""{"id":"local:1","source":"local","title":"Запись","artist":"На этом устройстве","artworkUrl":null,"duration":12.5,"downloadable":true,"fileName":"zapis.mp3","mimeType":"audio/mpeg","fileSize":4096,"savedAt":"2026-11-21T09:00:00.000Z"}"""))!!
    assertEquals(MusicTrack(id = "local:1", source = "local", title = "Запись", artist = "На этом устройстве", duration = 12.5, downloadable = true, fileName = "zapis.mp3", mimeType = "audio/mpeg", fileSize = 4096, savedAt = "2026-11-21T09:00:00.000Z"), kept)
    // Written and read back the same.
    assertEquals(kept, MusicPlayer.track(Core.value(Core.text(kept.json))))
    assertTrue(Core.text(kept.json)!!.contains("\"artworkUrl\":null") && Core.text(kept.json)!!.contains("\"fileSize\":4096"))
    assertNull(MusicPlayer.track(mapOf("id" to "", "source" to "local", "title" to "a", "artist" to "b")))
    assertNull(MusicPlayer.track(mapOf("id" to "x", "source" to "spotify", "title" to "a", "artist" to "b")))
    assertNull(MusicPlayer.track(mapOf("id" to "x".repeat(181), "source" to "local", "title" to "a", "artist" to "b")))
    assertNull(MusicPlayer.track(mapOf("id" to "x", "source" to "audius", "title" to "a", "artist" to "b", "artworkUrl" to "http://a.example.org/x.jpg"))!!.artworkUrl)
    val a = MusicTrack(id = "a", source = "local", title = "a", artist = "x"); val b = a.copy(id = "b")
    assertEquals(listOf(a, b), MusicPlayer.unique(listOf(a, b, a.copy(title = "again"))))
    assertEquals(500, MusicPlayer.unique((1..600).map { a.copy(id = "t$it") }).size)
    // The kind of a chosen file: by its name; without an ending — by what the system says of it.
    assertEquals("mp3", MusicPlayer.extension("Запись.MP3", null))
    assertEquals("flac", MusicPlayer.extension("a.b.flac", "audio/mpeg"))
    assertNull(MusicPlayer.extension("notes.txt", "audio/mpeg"))
    assertNull(MusicPlayer.extension("virus.exe", null))
    assertEquals("mp3", MusicPlayer.extension("recording", "audio/mpeg"))
    assertNull(MusicPlayer.extension("recording", "video/x-matroska"))
    assertNull(MusicPlayer.extension("recording", null))
  }

  @Test fun theWordsOfThePage() {
    assertEquals("0:00", MusicCatalog.time(-1.0))
    assertEquals("0:00", MusicCatalog.time(Double.NaN))
    assertEquals("0:07", MusicCatalog.time(7.9))
    assertEquals("3:34", MusicCatalog.time(214.0))
    assertEquals("61:01", MusicCatalog.time(3661.0))
    val track = MusicTrack(id = "audius:a", source = "audius", title = "Тихий час", artist = "Миша Ветров", duration = 243.0)
    assertEquals("Миша Ветров · 4:03 · AUDIUS", MusicWords.rowLine(track))
    assertEquals("Миша Ветров · SOUNDCLOUD", MusicWords.rowLine(track.copy(source = "soundcloud", duration = 0.0)))
    assertEquals("На этом устройстве · НА УСТРОЙСТВЕ", MusicWords.rowLine(track.copy(source = "local", artist = "На этом устройстве", duration = 0.0)))
    assertEquals(listOf("AUDIUS · ОНЛАЙН", "SOUNDCLOUD", "НА ЭТОМ УСТРОЙСТВЕ"), listOf("audius", "soundcloud", "local").map { MusicWords.origin(it) })
    assertEquals("Миша Ветров", MusicWords.miniLine("Миша Ветров", error = false, loading = false))
    assertEquals("Загружаем трек…", MusicWords.miniLine("Миша Ветров", error = false, loading = true))
    assertEquals("Есть сообщение · открыть", MusicWords.miniLine("Миша Ветров", error = true, loading = true))
    assertEquals("Новые имена и любимый звук", MusicWords.mixLine(null))
    assertEquals("Настроение: Спокойно", MusicWords.mixLine("Peaceful"))
    assertEquals("Свой звук", MusicWords.empty("saved", false, "Audius").first)
    assertEquals("Любимое будет здесь" to "Нажми на сердечко рядом с понравившимся треком.", MusicWords.empty("favorites", true, "Audius"))
    assertEquals("Посмотрим следующую страницу", MusicWords.empty("catalog", true, "Audius").first)
    assertEquals("Попробуем другой запрос" to "Измени название или настроение. Каталог SoundCloud отличается от других музыкальных сервисов.", MusicWords.empty("catalog", false, "SoundCloud"))
    assertEquals("Музыка предоставлена авторами через Audius.", MusicWords.footer("audius"))
    assertEquals(4, MusicWords.about(false).size)
    assertEquals(5, MusicWords.about(true).size)
    assertEquals(listOf("Условия Audius API", "Конфиденциальность Audius", "Open Music License"), MusicWords.links(false).map { it.first })
    assertEquals("Правила SoundCloud API", MusicWords.links(true).first().first)
    assertTrue(MusicWords.links(true).all { MusicCatalog.safeHttpsUrl(it.second) != null })
  }
}
