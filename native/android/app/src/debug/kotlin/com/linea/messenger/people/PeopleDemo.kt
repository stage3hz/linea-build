package com.linea.messenger.people

import android.app.Activity
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Launcher
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.shell.RootScreen

/** Made-up people for looking at «Люди» and a profile on the emulator while there is no account behind it.
 *  This file is in the debug source set: a release build is compiled with the empty `PeopleDemo` of src/release
 *  instead and contains none of this. */
object PeopleDemo {
  const val present = true

  private fun person(index: Int, name: String, username: String, color: Int, bio: String = "", birthday: String = "") =
    Person("demo-person-$index", username, name, bio, birthday, color, "")

  val friends: List<Person> = listOf(
    person(0, "Алиса Воронцова", "alisa_v", 0x5E7BFF, "Рисую карты и собираю гербарий. Пишите в любое время.", "03-02"),
    person(1, "Дмитрий Орлов", "orlov", 0xF2A33C),
    person(2, "Лев", "lev_m", 0x4FB86A),
    person(3, "Марина Ким", "marina.kim", 0xF26B5E),
    person(4, "Саша", "sasha", 0x3CA7F2),
  )
  val incoming: List<Person> = listOf(person(5, "Вера Соколова", "vera_s", 0x9B6BF2))
  val outgoing: List<Person> = listOf(person(6, "Игорь Белов", "belov", 0x34C3A0))
  private val everyone: List<Person> get() = friends + incoming + outgoing
  /** What a sample profile says of the person's presence. */
  val status: String? = "в сети"

  fun find(query: String): List<Person> {
    val wanted = query.lowercase().replace("@", "")
    return everyone.filter { it.displayName.lowercase().contains(wanted) || it.username.lowercase().contains(wanted) }
  }

  fun named(name: String): Person? = everyone.firstOrNull { it.displayName == name } ?: person(9, name, "demo", 0x5E7BFF)
}

/** What the emulator check asks of «Люди» by launch arguments (see `Demo.start`), as the iOS simulator check does:
 *    --es tab people              the section (with an account: friends, requests; with --ez demo true: samples)
 *    --es peoplesearch <query>    the section with the search field filled in and its results
 *    --es profile friend          the profile of the first friend (no friends: of the first request, else of the
 *                                 person of the first chat) — opened from «Люди», with «Написать»
 *    --es profile chat            the first chat, then the profile opened by a tap on its header */
object PeopleSimulator {
  /** True when the launch arguments ask something of «Люди». */
  private fun asked(intent: Intent): Boolean = intent.getStringExtra("peoplesearch") != null || intent.getStringExtra("profile") != null

  /** With the shell of samples (`demo`): at once. */
  fun run(intent: Intent, launcher: Launcher, root: RootScreen) {
    if (!asked(intent)) return
    act(intent, root)
    if (intent.getStringExtra("profile") == "chat") {
      // Without an account there is no list to open the first chat of: the sample chat.
      launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false)
      root.postDelayed({ topChat(root)?.openProfile() }, 1500)
    }
  }

  /** With an account: once its shell is on the screen (the window makes it by itself after `Demo.start`). */
  fun later(intent: Intent, launcher: Launcher) {
    val tab = intent.getStringExtra("tab")
    if (!asked(intent) && tab == null) return
    val window = (launcher as? Activity)?.window ?: return
    val page = window.decorView
    var tries = 0
    val look = object : Runnable {
      override fun run() {
        val root = find(page)
        if (root == null) { tries += 1; if (tries < 40) page.postDelayed(this, 500); return }
        tab?.let { root.show(it) }
        act(intent, root)
        if (intent.getStringExtra("profile") == "chat") {
          // The list of chats is read from the server first (as `openchat` waits for it).
          root.postDelayed({ launcher.openFirstChat(); root.postDelayed({ topChat(root)?.openProfile() }, 1500) }, 6000)
        }
      }
    }
    page.post(look)
  }

  private fun act(intent: Intent, root: RootScreen) {
    val query = intent.getStringExtra("peoplesearch"); val profile = intent.getStringExtra("profile")
    if (query != null || profile == "friend") root.show("people")
    if (query != null) root.peoplePage()?.emulatorSearch(query)
    if (profile == "friend") root.peoplePage()?.emulatorOpenFirstProfile()
  }

  private fun find(view: View): RootScreen? {
    if (view is RootScreen) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
    return null
  }

  /** The chat on top of the stack of pages, if that is what is there. */
  private fun topChat(root: RootScreen): ChatScreen? {
    val stack = root.pages() ?: return null
    return stack.getChildAt(stack.childCount - 1) as? ChatScreen
  }
}
