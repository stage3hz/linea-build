package com.linea.messenger.links

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.channels.ChannelWords
import com.linea.messenger.channels.ChannelsRoute
import com.linea.messenger.security.AccountNotices
import com.linea.messenger.security.LockGate
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen
import java.lang.ref.WeakReference

/** Links that open the app: `linea://invite/CODE` (the VIEW filter of the manifest: the previous app's schemes). Only our
 *  own addresses are recognised (`ChannelWords.inviteCode`, the reference's `inviteCodeFrom`); the invitation itself is
 *  always asked from our server by its code and shown as «Приглашение» over «Каналы» (channels/CommunityForms.kt,
 *  `InvitePage`). A link that comes before the account is open waits for it. (The previous app: `App.tsx`, `Linking`;
 *  iOS Links/DeepLinks.swift.) */
object DeepLinks {
  private var waiting: String? = null
  private var window = WeakReference<Activity>(null)
  private val main = Handler(Looper.getMainLooper())

  /** The code of an intent that opened the app, when it is one of ours; nothing else of the intent is read. */
  fun code(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_VIEW) return null
    val address = intent.dataString ?: return null
    return ChannelWords.inviteCode(address)
  }

  /** A link given to the app (at start, or while it runs). True when it was ours. */
  fun open(activity: Activity, intent: Intent?): Boolean {
    val found = code(intent) ?: return false
    window = WeakReference(activity)
    waiting = found
    main.post { deliver() }
    return true
  }

  /** The account is open now (security/AccountNotices.kt): a waiting link is shown. */
  fun accountReady() {
    if (waiting == null) return
    main.postDelayed({ deliver() }, 600)
  }

  private fun deliver(tries: Int = 10) {
    val found = waiting ?: return
    val messenger = AccountNotices.messenger
    val root = window.get()?.window?.decorView?.let { shell(it) }
    if (messenger == null || LockGate.locked || root == null) {
      // Not signed in yet, or locked: tried again shortly (and again when the account opens).
      if (tries > 0) main.postDelayed({ deliver(tries - 1) }, 1000)
      return
    }
    waiting = null
    val stack = root.parent as? Navigation
    if (stack != null) while (stack.depth > 1) stack.pop(animated = false)
    root.show("channels")
    root.post { ChannelsRoute.openInvite(root, messenger, found) }
  }

  private fun shell(view: View, depth: Int = 0): RootScreen? {
    if (view is RootScreen) return view
    if (depth > 6 || view !is ViewGroup) return null
    for (index in 0 until view.childCount) shell(view.getChildAt(index), depth + 1)?.let { return it }
    return null
  }
}
