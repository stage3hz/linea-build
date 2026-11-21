package com.linea.messenger.people

/** The release build's side of the people samples (see src/debug): there are none, and no launch arguments. */
object PeopleDemo {
  const val present = false
  val friends: List<Person> = emptyList()
  val incoming: List<Person> = emptyList()
  val outgoing: List<Person> = emptyList()
  /** What a sample profile says of the person's presence. */
  val status: String? = null

  @Suppress("UNUSED_PARAMETER")
  fun find(query: String): List<Person> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun named(name: String): Person? = null
}
