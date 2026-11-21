package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import com.linea.messenger.chats.DecorStore
import com.linea.messenger.design.Theme
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.LocalDate

/** What the chat list (chats/ChatRowView.kt, which draws each row in one pass) needs to show a person's decoration
 *  (iOS Avatars/ChatListDecor.swift with ChatsPlus/ChatRowLooks.swift `applyPerson`): the row keys of `ChatRow.parse`
 *  and the pictures it looks up in `DecorStore`.
 *
 *    ChatListDecor.install(context)   once (cheap to call again): the ten nameplates and the eight code frames'
 *                                     still pictures go into DecorStore
 *    row + ChatListDecor.fields(peer) the status emoji after the name (`title`), `ring` (ARGB colours), `deco` +
 *                                     `decoScale`, `plate`, `metal` + `nameLen`
 *
 *  As the reference's list: frames and art stand still (they move in profiles); no gem in the rows. */
object ChatListDecor {
  private var installed = false

  fun install(context: Context) {
    if (installed) return
    installed = true
    val pictures = LinkedHashMap<String, String>()
    for (plate in AvatarCatalog.plates) Nameplates.base64(plate.id)?.let { pictures[plate.id] = it }
    // The list's avatar is 60 dp: the still code frames are drawn for it.
    val avatar = Math.round(60 * context.resources.displayMetrics.density)
    for (frame in AvatarCatalog.codeFrames) pictures[frame.id] = png(CodeFrameView.still(context, frame.id, avatar))
    DecorStore.setPlates(pictures)
  }

  private fun png(bitmap: Bitmap): String {
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }

  /** The row keys for a chat's `peer` as the server sends it (the row's title is the person's display name). */
  fun fields(peer: Map<String, Any?>, now: Instant = Instant.now(), today: LocalDate = LocalDate.now(), dark: Boolean = Theme.dark): Map<String, Any?> {
    val look = PersonLook.from(peer)
    val name = peer["displayName"] as? String ?: ""
    val made = LinkedHashMap<String, Any?>()
    look.visibleStatus(now)?.let { made["title"] = "$name $it" }
    val birthday = look.birthdayToday(today)
    val decoration = AvatarCatalog.decoration(look.avatarFrame)
    if (!birthday && AvatarCatalog.isCodeFrame(look.avatarFrame)) {
      made["deco"] = look.avatarFrame
      made["decoScale"] = AvatarCatalog.codeFrameScale.toDouble()
    } else if (!birthday && decoration != null) {
      made["deco"] = decoration.file
      made["decoScale"] = decoration.scale.toDouble()
    } else {
      AvatarCatalog.ringColors(look, today)?.let { made["ring"] = PlatinaMetal.argb(it) }
    }
    if (AvatarCatalog.plate(look.nameplate) != null) made["plate"] = look.nameplate
    if (look.platina) {
      // On a plate (dark art) the light metal, also in a light theme.
      made["metal"] = PlatinaMetal.argb(if (look.nameplate.isNotEmpty() || dark) PlatinaMetal.name else PlatinaMetal.nameLight)
      made["nameLen"] = name.length
    }
    return made
  }
}
