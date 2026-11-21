package com.linea.messenger.chatsplus

import android.content.Intent
import com.linea.messenger.people.Person

/** The release build's side of the chat list's demo (see src/debug): no samples, no launch arguments. */
object ChatsPlusDemo {
  const val present = false
  val chatsdemo: String? get() = null
  val hint: Boolean? get() = null
  val calls: Boolean get() = false
  val savedSearch: Boolean get() = false

  @Suppress("UNUSED_PARAMETER")
  fun read(intent: Intent) {}

  fun sampleFolderChats(): List<FolderChat> = emptyList()
  fun people(): List<Person> = emptyList()
  fun savedItems(): List<Map<String, Any?>> = emptyList()
  fun callRecords(): List<CallRecord> = emptyList()
  fun peekLines(): List<ChatPeekMenu.Line> = emptyList()
}
