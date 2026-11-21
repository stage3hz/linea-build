package com.linea.messenger.linkpreview

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Opening a link of a chat in the system browser (the previous app: `openLink` in
 *  mobile/src/format/FormattedText.tsx with `linkTextMatchesUrl` of mobile/src/format/entities.ts). */
object LinkOpen {
  /** `linkTextMatchesUrl`: whether the words already show where the link goes. */
  fun matches(shown: String, url: String): Boolean {
    fun strip(value: String): String {
      var text = value.trim()
      for (scheme in listOf("https://", "http://")) {
        if (text.lowercase().startsWith(scheme)) { text = text.substring(scheme.length); break }
      }
      if (text.lowercase().startsWith("www.")) text = text.substring(4)
      while (text.endsWith("/")) text = text.dropLast(1)
      return text.lowercase()
    }
    val words = strip(shown)
    return words.isNotEmpty() && words == strip(url)
  }

  /** Only the two schemes of the web are ever handed to the system: nothing else in a message opens anything. */
  fun opens(url: String): Boolean {
    val lower = url.lowercase()
    return lower.startsWith("https://") || lower.startsWith("http://")
  }

  /** What `pressed` does with a link: "" nothing, "open" at once, "ask" after a confirmation. */
  fun step(url: String, shown: String): String = if (!opens(url)) "" else if (matches(shown, url)) "open" else "ask"

  private fun go(context: Context, url: String) {
    val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
    if (context !is Activity) view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { context.startActivity(view) } catch (_: Exception) { /* no app shows links */ }
  }

  /** A link in a message's text: opened at once when its words show the address; a link whose words hide the
   *  address («подробнее» → https://…) is confirmed first, with the whole address shown. */
  fun pressed(context: Context, url: String, shown: String) {
    when (step(url, shown)) {
      "open" -> go(context, url)
      "ask" -> try {
        AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Открыть ссылку?").setMessage(url)
          .setNegativeButton("Отмена", null).setPositiveButton("Открыть") { _, _ -> go(context, url) }.show()
      } catch (_: Exception) { /* the window is gone */ }
    }
  }

  /** The card of a link: its address is the link written in the message itself, so nothing is asked. */
  fun cardPressed(context: Context, url: String) {
    if (opens(url)) go(context, url)
  }
}
