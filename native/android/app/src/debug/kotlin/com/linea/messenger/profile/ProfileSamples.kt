package com.linea.messenger.profile

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Launcher
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.NameplateView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaGemView
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.titled
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonProfileScreen
import com.linea.messenger.platina.PlatinaConfettiHost
import com.linea.messenger.platina.PlatinaSamples
import com.linea.messenger.platina.PlatinaShowcase
import com.linea.messenger.platina.PlatinaStudioScreen
import com.linea.messenger.shell.Screen
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.LocalDate
import java.util.Locale

/** Made-up people dressed in every decoration, for the emulator checks of avatars, profiles and Platina (no account;
 *  iOS Profile/ProfileSamples.swift). In the debug source set only; a release build has none of this. */
object ProfileSamples {
  private fun person(index: Int, name: String, username: String, color: Int, bio: String = "", birthday: String = "", look: Map<String, Any?> = emptyMap()): Person {
    val all = LinkedHashMap(look)
    if (birthday.isNotEmpty()) all["birthday"] = birthday
    return Person("sample-person-$index", username, name, bio, birthday, color, "", PersonLook.from(all))
  }

  /** Today as «MM-DD» (a birthday that is today). */
  val today: String get() = LocalDate.now().let { String.format(Locale.ROOT, "%02d-%02d", it.monthValue, it.dayOfMonth) }

  val permanentStatus: Map<String, Any?> = mapOf("statusEmoji" to "🔥", "statusEmojiPermanent" to true, "statusEmojiExpiresAt" to null)

  /** The sample account as the server's `user` (Settings' head without an account). */
  val meRaw: Map<String, Any?>
    get() = linkedMapOf<String, Any?>("id" to "sample-person-0", "displayName" to "Мария Орлова", "username" to "maria", "avatarColor" to "#9271C3", "bio" to "Рисую карты и собираю гербарий.", "birthday" to "03-02",
      "seal" to "platina", "avatarFrame" to "platinum", "bannerPreset" to "aurora", "profileEffect" to "sparks", "nameplate" to "deep", "profilePattern" to "⭐") + permanentStatus

  /** The sample account as a person (iOS ProfileSamples.me). */
  val me: Person
    get() = person(0, "Мария Орлова", "maria", 0x9271C3, bio = "Рисую карты и собираю гербарий.", birthday = "03-02",
      look = mapOf("seal" to "platina", "avatarFrame" to "platinum", "bannerPreset" to "aurora", "profileEffect" to "sparks", "nameplate" to "deep", "profilePattern" to "⭐") + permanentStatus)

  /** A sample of each kind of frame: rings, code frames, art. */
  fun dressed(frame: String, index: Int): Person = person(10 + index, "Алиса Воронцова", "alisa_v", listOf(0x5E7BFF, 0xF2A33C, 0x4FB86A, 0xF26B5E, 0x3CA7F2, 0x9B6BF2)[index % 6], look = mapOf("avatarFrame" to frame, "seal" to "platina"))

  val birthdayFriend: Person get() = person(30, "Дмитрий Орлов", "orlov", 0xF2A33C, bio = "Сегодня мой день.", birthday = today, look = mapOf("gender" to "male"))

  val platinaFriend: Person
    get() = person(31, "Вера Соколова", "vera_s", 0x9B6BF2, bio = "Фотограф. Горы, туман и плёнка.", birthday = "07-14",
      look = mapOf("seal" to "platina", "avatarFrame" to "fx-aurora", "bannerPreset" to "glacier", "profileEffect" to "snow", "nameplate" to "night", "profilePattern" to "🦋") + permanentStatus + mapOf("statusEmoji" to "💎"))

  fun gifts(own: Boolean): List<ProfileGift> {
    val senders = listOf(person(40, "Лев", "lev_m", 0x4FB86A), person(41, "Марина Ким", "marina.kim", 0xF26B5E), person(42, "Саша", "sasha", 0x3CA7F2))
    return listOf(
      ProfileGift("g1", "rose", "С днём рождения!", "", senders[0]), ProfileGift("g2", "rocket", "", "", senders[1]),
      ProfileGift("g3", "crown", "Ты лучшая", "", senders[2]), ProfileGift("g4", "bear", "", "", null), ProfileGift("g5", "diamond", "", "", senders[0]),
    )
  }

  /** A drawn picture standing in for a photo (sample avatars and banners). */
  fun picture(seed: Int, width: Int = 600, height: Int = 600): Bitmap {
    val pairs = listOf(0x2B5876 to 0x4E4376, 0xF2994A to 0xEB5757, 0x11998E to 0x38EF7D, 0x8E2DE2 to 0x4A00E0)
    val pair = pairs[seed % pairs.size]
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), 0xFF000000.toInt() or pair.first, 0xFF000000.toInt() or pair.second, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    paint.shader = null
    paint.color = 0x40FFFFFF
    for (index in 0 until 5) {
      val r = width * (0.08f + index * 0.03f)
      canvas.drawOval(width * (0.15f + index * 0.17f), height * (0.6f - (index % 2) * 0.3f), width * (0.15f + index * 0.17f) + r, height * (0.6f - (index % 2) * 0.3f) + r, paint)
    }
    return bitmap
  }

  /** Photos, a video, files, voice and round video messages and links, as a chat leaves them. */
  fun sampleHistory(): List<Map<String, Any?>> {
    val list = ArrayList<Map<String, Any?>>()
    val start = Instant.now().minusSeconds(86400L * 9)
    fun add(text: String, attachment: Map<String, Any?>?, days: Double) {
      val id = list.size + 1
      list.add(mapOf("id" to id, "senderId" to if (id % 2 == 0) "demo-me" else "demo-peer", "clientId" to "c$id", "text" to text, "createdAt" to start.plusSeconds((days * 86400).toLong()).toString(),
        "cryptoState" to "decrypted", "rowKey" to "k$id", "attachment" to attachment))
    }
    fun jpeg(bitmap: Bitmap): String = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray().let { Base64.encodeToString(it, Base64.NO_WRAP) }
    for (index in 0 until 7) add("", mapOf("id" to "p$index", "name" to "photo.jpg", "mimeType" to "image/jpeg", "size" to 180_000 + index * 9000, "preview" to mapOf("base64" to jpeg(picture(index, 240, 240)))), index * 0.7)
    add("", mapOf("id" to "v1", "name" to "walk.mp4", "mimeType" to "video/mp4", "size" to 8_400_000, "preview" to mapOf("base64" to jpeg(picture(2, 240, 160))), "media" to mapOf("durationMs" to 74_000)), 5.0)
    add("", mapOf("id" to "f1", "name" to "Отчёт за ноябрь.pdf", "mimeType" to "application/pdf", "size" to 1_240_000), 5.5)
    add("", mapOf("id" to "f2", "name" to "Таблица.xlsx", "mimeType" to "application/vnd.ms-excel", "size" to 86_000), 6.0)
    add("", mapOf("id" to "a1", "name" to "voice-1730000000.m4a", "mimeType" to "audio/mp4", "size" to 42_000), 6.5)
    add("", mapOf("id" to "a2", "name" to "circle-1730000001.mp4", "mimeType" to "video/mp4", "size" to 900_000), 7.0)
    add("Посмотри https://example.org/articles/notes — там про это", null, 7.5)
    add("Билеты тут: https://tickets.example.com/event/42.", null, 8.0)
    return list
  }

  /** The debug build's hooks: sample gifts, the sample account for the showcase, the studio and «Мой профиль». */
  fun install() {
    GiftSamples.make = { own -> gifts(own) }
    PlatinaSamples.me = { meRaw }
  }
}

/** The emulator checks of avatars, profiles, Platina and gifts — sample data, no account (the same launch arguments
 *  as the iOS simulator check, Profile/ProfileSimulator.swift):
 *    --es profiledemo rings|code|art|list|marks|fonts      galleries: turning rings + the birthday ring, frames drawn in
 *                                                         code, painted art (all moving), the still list sizes,
 *                                                         Platina's name / seal / gem / status / nameplates, the type
 *    --es profiledemo person|birthday|own|gifts           someone's profile in Platina dress, a friend's birthday, one's
 *                                                         own profile, the «Подарки» tab
 *    --es profiledemo showcase|studio|confetti|offer      Platina: the showcase, the studio, «Платина активирована»,
 *                                                         Settings with the head and the offer
 *    --es profiledemo mini|mini-chat|media|cropper|banner|pattern|status|giftsheet
 *    --es profiledemo chatprofile|chatprofile-more|chatprofile-files|chatprofile-mute|chatprofile-ttl
 *    --ez profilelook true                                with demo: the sample account wears Platina (Settings' head) */
object ProfileSimulator {
  /** `--ez profilelook true`: the sample person of Settings wears Platina. */
  var look = false
    private set

  fun demo(intent: Intent, launcher: Launcher): Boolean {
    ProfileSamples.install()
    look = intent.getBooleanExtra("profilelook", false)
    val what = intent.getStringExtra("profiledemo") ?: return false
    val root = launcher.showDemo()
    val context = root.context
    val stack = root.pages() ?: return true
    val later = { job: () -> Unit -> Handler(Looper.getMainLooper()).postDelayed(job, 1000) }
    when (what) {
      "rings", "code", "art", "list", "marks", "fonts" -> stack.push(AvatarGalleryScreen(context, what), animated = false)
      "person" -> ProfileSamples.platinaFriend.let { stack.push(PersonProfileScreen(context, null, it.id, it.displayName, it), animated = false) }
      "birthday" -> ProfileSamples.birthdayFriend.let { stack.push(PersonProfileScreen(context, null, it.id, it.displayName, it), animated = false) }
      "own" -> stack.push(OwnProfileScreen(context, null), animated = false)
      "gifts" -> {
        val page = OwnProfileScreen(context, null)
        stack.push(page, animated = false)
        later { findPosts(page)?.emulatorShow("gift") }
      }
      "showcase" -> later { PlatinaShowcase.open(root, ProfileSamples.platinaFriend.id to ProfileSamples.platinaFriend.displayName) }
      "studio" -> stack.push(PlatinaStudioScreen(context, null), animated = false)
      // Late, so the shot taken 7 s after the launch (emu-shots.sh) catches the confetti in the air.
      "confetti" -> Handler(Looper.getMainLooper()).postDelayed({ PlatinaConfettiHost.show(root) }, 5_200)
      "offer" -> root.show("profile")
      "mini", "mini-chat" -> later {
        val quick = if (what == "mini-chat") MiniProfile.Quick({}, {}, false, {}) else null
        MiniProfile(context, ProfileSamples.platinaFriend, null, "в сети", onWrite = {}, onOpenProfile = {}, quick = quick).show()
      }
      "media" -> later {
        val friend = ProfileSamples.platinaFriend.copy(avatarId = "sample-photo")
        ProfileMediaViewer(context, friend, "").apply { samplePicture = ProfileSamples.picture(2, 900, 900) }.show()
      }
      "cropper" -> later { AvatarCropper(context, ProfileSamples.picture(1, 1200, 900)).show() }
      "banner" -> later { BannerPreview(context, null, ProfileSamples.picture(3, 1200, 800), sample = ProfileSamples.me).show() }
      "pattern" -> later { PatternPicker(context, "🦋") {}.show() }
      "status" -> {
        val own = OwnProfileScreen(context, null)
        stack.push(own, animated = false)
        later { StatusPicker(context, context.px(300f), mapOf("platina" to mapOf("active" to true), "canSetStatusEmoji" to true, "statusEmojiChoices" to AvatarCatalog.statusEmoji), "🔥").show() }
      }
      "giftsheet" -> later { GiftSheet(context, null, "sample").show() }
      else -> if (what.startsWith("chatprofile")) chatProfile(what, launcher, context)
    }
    return true
  }

  private fun findPosts(view: View): com.linea.messenger.stories.ProfilePostsBlock? {
    if (view is com.linea.messenger.stories.ProfilePostsBlock) return view
    if (view is android.view.ViewGroup) for (index in 0 until view.childCount) findPosts(view.getChildAt(index))?.let { return it }
    return null
  }

  /** The profile opened from the sample chat: «Звонок · Видео · Звук · Поиск · Ещё», the shared media, «Ещё», the
   *  sound sheet, «Автоудаление». */
  private fun chatProfile(what: String, launcher: Launcher, context: Context) {
    launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false)
    Handler(Looper.getMainLooper()).postDelayed({
      val root = (context as? android.app.Activity)?.window?.decorView ?: return@postDelayed
      val chat = findChat(root) ?: return@postDelayed
      val friend = ProfileSamples.platinaFriend
      val profile = PersonProfileScreen(context, null, friend.id, friend.displayName, friend, chatId = "demo")
      val link = ProfileChatLink(chat, "demo")
      link.sampleMessages = ProfileSamples.sampleHistory()
      profile.chatLink = link
      chat.pages()?.push(profile, animated = false)
      Handler(Looper.getMainLooper()).postDelayed({
        when (what) {
          "chatprofile-files" -> profile.emulatorShared("files")
          "chatprofile-mute" -> ProfileChatExtras.muteSheet(context, friend.displayName) {}
          "chatprofile-ttl" -> ProfileChatExtras.autoDeleteSheet(context, 604800) {}
          "chatprofile-more" -> profile.emulatorMore()
          else -> profile.emulatorShared("")
        }
      }, 1000)
    }, 300)
  }

  private fun findChat(view: View): ChatScreen? {
    if (view is ChatScreen) return view
    if (view is android.view.ViewGroup) for (index in 0 until view.childCount) findChat(view.getChildAt(index))?.let { return it }
    return null
  }
}

/** Galleries of the decorations and the type for the emulator checks. */
class AvatarGalleryScreen(context: Context, private val mode: String) : Screen(context) {
  private val scroll = ScrollView(context)
  private val column = LinearLayout(context)

  init {
    setBackgroundColor(Theme.bg)
    column.orientation = LinearLayout.VERTICAL
    column.clipChildren = false
    scroll.clipChildren = false
    scroll.addView(column)
    addView(scroll)
    val rings = AvatarCatalog.frames.map { it.id to it.label }
    val codes = AvatarCatalog.codeFrames.map { it.id to it.label }
    val arts = AvatarCatalog.decorations.map { it.id to it.label }
    when (mode) {
      "rings" -> { caption("Кольца (вращаются)"); grid(rings, 80f, true); caption("День рождения"); grid(listOf("" to "🎂"), 80f, true, birthday = true) }
      "code" -> { caption("Рамки, нарисованные кодом"); grid(codes, 80f, true) }
      "art" -> { caption("Украшения"); grid(arts, 70f, true) }
      "list" -> { caption("В списке (неподвижно)"); grid(rings + codes + arts, 54f, false) }
      "marks" -> marks()
      else -> fonts()
    }
  }

  private fun caption(text: String) {
    column.addView(context.words(text, 13f, Theme.muted, 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(16f); topMargin = dp(12f); bottomMargin = dp(8f) })
  }

  private fun grid(items: List<Pair<String, String>>, size: Float, animated: Boolean, birthday: Boolean = false) {
    val columns = if (size > 64) 3 else 5
    var row: LinearLayout? = null
    items.forEachIndexed { index, (id, label) ->
      if (index % columns == 0) { row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false; setPadding(dp(16f), 0, dp(16f), 0) }; column.addView(row) }
      val cell = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; clipChildren = false }
      val box = FrameLayout(context).apply { clipChildren = false }
      val person = if (birthday) ProfileSamples.birthdayFriend else ProfileSamples.dressed(id, index)
      val avatar = DecoratedAvatarView(context)
      if (index % 2 == 0) avatar.overridePicture = ProfileSamples.picture(index, 300, 300)
      avatar.show(person, person.look, "", animated)
      box.addView(avatar, FrameLayout.LayoutParams(dp(size), dp(size), Gravity.CENTER))
      cell.addView(box, LinearLayout.LayoutParams(dp(size * 1.5f), dp(size * 1.5f)))
      cell.addView(context.words(label, 11f, Theme.muted).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(16f)).apply { topMargin = dp(6f) })
      row?.addView(cell, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { bottomMargin = dp(12f) })
    }
    val rest = (columns - items.size % columns) % columns
    repeat(rest) { row?.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f)) }
  }

  private fun marks() {
    caption("Платиновое имя, печать, значок, статус")
    val name = PlatinaNameView(context)
    name.titled(27f)
    name.show("Вера Соколова", platina = true)
    column.addView(name, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(16f) })
    val line = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16f), dp(10f), dp(16f), dp(10f)) }
    line.addView(PlatinaSealView(context))
    line.addView(PlatinaSealView(context, small = true), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) })
    line.addView(PlatinaGemView(context, 13f), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) })
    line.addView(StatusEmojiView(context).apply { show(ProfileSamples.platinaFriend.look, 22f) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) })
    column.addView(line)
    caption("Таблички")
    for (plate in AvatarCatalog.plates) {
      val box = FrameLayout(context)
      box.addView(NameplateView(context).apply { show(plate.id, dp(20f).toFloat()) }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      box.addView(context.words(plate.label, 16f, 0xFFFFFFFF.toInt(), 600).apply { gravity = Gravity.CENTER_VERTICAL }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(16f) })
      column.addView(box, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64f)).apply { leftMargin = dp(16f); rightMargin = dp(16f); bottomMargin = dp(8f) })
    }
  }

  private fun fonts() {
    val samples = listOf("Чаты — Unbounded 30" to Theme.TypeSize.chatsTitle, "Каналы — Unbounded 26" to Theme.TypeSize.sectionTitle, "Имя профиля — Unbounded 27" to Theme.TypeSize.profileName, "Настройки — Unbounded 22" to Theme.TypeSize.pageTitle)
    for ((words, size) in samples) column.addView(TextView(context).apply { text = words; setTextColor(Theme.text); titled(size) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(16f); topMargin = dp(14f) })
    for ((words, size, weight) in listOf(Triple("Montserrat ExtraBold 18", 18f, 800), Triple("Montserrat Bold 17", 17f, 700), Triple("Montserrat SemiBold 16", 16f, 600),
        Triple("Montserrat Medium 15", 15f, 500), Triple("Montserrat Regular 15 — системный шрифт", 15f, 400), Triple("Montserrat Regular 12", 12f, 400))) {
      column.addView(context.words(words, size, Theme.text, weight), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(16f); topMargin = dp(14f) })
    }
  }

  override fun place(width: Int, height: Int) {
    column.setPadding(0, edges.top + dp(56f), 0, dp(40f) + edges.bottom)
    put(scroll, 0, 0, width, height)
  }
}
