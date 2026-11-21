package com.linea.messenger.shell

import android.content.Intent
import com.linea.messenger.app.Launcher

/** The release build's side of the shell's demo (see src/debug): no launch arguments. */
object ShellDemo {
  val shell: String? get() = null
  val update: String? get() = null

  @Suppress("UNUSED_PARAMETER")
  fun read(intent: Intent) {}

  @Suppress("UNUSED_PARAMETER")
  fun run(root: RootScreen, launcher: Launcher, stack: Navigation?) {}
}
