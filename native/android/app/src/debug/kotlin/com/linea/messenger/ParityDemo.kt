package com.linea.messenger

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Launcher
import com.linea.messenger.effects.EffectsHost
import com.linea.messenger.language.Language
import com.linea.messenger.profile.pages
import com.linea.messenger.security.AccountNotices
import com.linea.messenger.security.LockGate
import com.linea.messenger.security.TrustSheet

/** The launch arguments of the emulator check for the effects, the lock, the notices, the language and the screen
 *  sharing — the same names as the iOS simulator's (Links/ParitySimulator.swift). Debug builds only.
 *    --es effects 1                   the snow, the trail and the rime are on (otherwise off on a check launch)
 *    --es snowheat 0.9                the snow and the rime as on a hot phone
 *    --es setlanguage en|ru           the language of the interface (kept, as the settings keep it)
 *    --es lockdemo digits|wrong|password      the lock screen with a sample code
 *    --es noticedemo both|loginsheet|recoverysheet    the notices above the chats, their sheets
 *    --ez trustdemo true / --es trustdemo 1   «Защита чата» with two sample devices
 *    --es screendemo panel|viewer|starting|sharing|error|room|bar    screen sharing (screenshare/ScreenShareDemo.kt) */
object ParityDemo {
  private val main = Handler(Looper.getMainLooper())

  fun start(intent: Intent, launcher: Launcher): Boolean {
    // A launch with arguments is a check: the effects only when it asks for them.
    if (intent.extras?.isEmpty == false) EffectsHost.allowed = intent.getStringExtra("effects") == "1"
    intent.getStringExtra("snowheat")?.toFloatOrNull()?.let { EffectsHost.testHeat = it }
    intent.getStringExtra("setlanguage")?.let { Language.set(it) }
    intent.getStringExtra("lockdemo")?.let { kind ->
      Demo.lockDemo = true
      launcher.showDemo()
      (launcher as? Activity)?.let { activity -> main.postDelayed({ LockGate.demo(activity, kind) }, 300) }
      return true
    }
    intent.getStringExtra("noticedemo")?.let { kind ->
      val root = launcher.showDemo()
      AccountNotices.showSamples(login = kind != "recoverysheet", recovery = kind != "loginsheet")
      root.requestLayout()
      if (kind == "loginsheet" || kind == "recoverysheet") main.postDelayed({ AccountNotices.openSheet(if (kind == "loginsheet") "login" else "recovery", root) }, 1200)
      return true
    }
    if (intent.getBooleanExtra("trustdemo", false) || intent.getStringExtra("trustdemo") == "1") {
      val root = launcher.showDemo()
      main.postDelayed({ TrustSheet.present(root, null, "sample-peer") }, 900)
      return true
    }
    if (com.linea.messenger.screenshare.ScreenShareDemo.start(intent, launcher)) return true
    return false
  }
}
