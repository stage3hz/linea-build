package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.findPeople

/** ChatsPlus: «Архив» as a view above the first chat, out of sight until the list is pulled down: the box icon on a
 *  rounded square, «Архив» and how many chats are in it. The list (chats/ChatListView.kt `setPull`) can show it while
 *  pulled and let it settle open or shut. Not put in the list now: «Архив» is an ordinary row under «Избранное», as
 *  the previous app's list shows it (chatsplus/ChatListPlus.kt `archivePull`, chatactions/ChatListActions.kt). */
@SuppressLint("ViewConstructor")
class ArchivePullView(context: Context) : LinearLayout(context) {
  private val count: TextView = context.words("", 12f, Theme.muted)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(16f), 0, context.px(16f), 0)
    val box = FrameLayout(context).apply { background = context.plate(Theme.surface2, 19f) }
    box.addView(PlusIconView(context, "archivebox.fill", 23f, Theme.muted), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(box, LayoutParams(context.px(54f), context.px(54f)))
    val words = LinearLayout(context).apply { orientation = VERTICAL }
    words.addView(context.words("Архив", 15f, Theme.text, 700))
    words.addView(count.apply { setPadding(0, context.px(4f), 0, 0) })
    addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(13f) })
    isClickable = true
    isFocusable = true
    background = android.graphics.drawable.StateListDrawable().apply {
      addState(intArrayOf(android.R.attr.state_pressed), android.graphics.drawable.ColorDrawable(Theme.veil(0.07f)))
    }
    layoutParams = android.widget.AbsListView.LayoutParams(android.widget.AbsListView.LayoutParams.MATCH_PARENT, context.px(HEIGHT))
  }

  fun set(chats: Int) {
    count.text = "$chats " + plural(chats, "чат", "чата", "чатов")
    contentDescription = "Архив, чатов: $chats"
  }

  companion object {
    const val HEIGHT = 78f

    fun plural(count: Int, one: String, few: String, many: String): String {
      val last = Math.abs(count) % 10; val tens = Math.abs(count) % 100
      if (last == 1 && tens != 11) return one
      if (last in 2..4 && (tens < 12 || tens > 14)) return few
      return many
    }
  }
}

/** ChatsPlus: people by @name inside the list's search (ChatSearch.tsx «Люди»): from two letters, the server's people
 *  search (300 ms after the last letter); the people who already have a chat here are found among the chats, the
 *  others come under «Люди». A touch opens the chat with the person (made when there is none yet). */
class ListPeopleSearch(private val messenger: Messenger?) {
  private var asked = ""
  private var answeredFor = ""
  private var found: List<Person> = emptyList()
  private val main = Handler(Looper.getMainLooper())
  private var soon: Runnable? = null
  /** New people arrived: the rows are made again. */
  var onChange: (() -> Unit)? = null

  /** The rows of «Люди» for the words in the field. `known`: the people the list's chats are with. */
  fun rows(query: String, known: Set<String>, me: String): List<Map<String, Any?>> {
    val wanted = query.trim().lowercase()
    if (wanted.length < 2) {
      asked = ""
      soon?.let { main.removeCallbacks(it) }
      return emptyList()
    }
    if (wanted != asked) {
      asked = wanted
      ask(wanted)
    }
    if (answeredFor != wanted) return emptyList()
    return rowsFor(found, known, me)
  }

  fun person(id: String): Person? = found.firstOrNull { it.id == id }

  private fun ask(wanted: String) {
    soon?.let { main.removeCallbacks(it) }
    val work = Runnable {
      if (asked != wanted) return@Runnable
      val messenger = messenger
      if (messenger == null) {
        val needle = wanted.replace("@", "")
        found = ChatsPlusDemo.people().filter { (it.displayName + " " + it.username).lowercase().contains(needle) }
        answeredFor = wanted
        onChange?.invoke()
        return@Runnable
      }
      messenger.findPeople(wanted) { result ->
        main.post {
          if (asked != wanted) return@post
          found = result.getOrNull() ?: emptyList()
          answeredFor = wanted
          onChange?.invoke()
        }
      }
    }
    soon = work
    main.postDelayed(work, 300)
  }

  companion object {
    /** The reference's rule (components.tsx:149), one for every avatar: `Messenger.initials`. */
    fun initials(name: String): String = Messenger.initials(name)

    /** The rows of the people found (not this account, not the people the list already has a chat with). */
    fun rowsFor(found: List<Person>, known: Set<String>, me: String): List<Map<String, Any?>> {
      val rows = ArrayList<Map<String, Any?>>()
      for (person in found) {
        if (person.id == me || known.contains(person.id)) continue
        val pair = orbPair(person.avatarColor)
        rows.add(mapOf(
          "id" to "user|" + person.id, "title" to person.displayName.ifEmpty { "@" + person.username },
          "preview" to "@" + person.username, "time" to "", "unread" to 0, "initials" to initials(person.displayName),
          "avatarColor" to (0xFF000000.toInt() or (person.avatarColor and 0xFFFFFF)), "orbA" to pair.first, "orbB" to pair.second,
          "section" to (if (rows.isEmpty()) "Люди" else ""), "previewIcon" to "",
        ))
      }
      return rows
    }
  }
}
