package com.linea.messenger.stories

/** The release build's side of the stories samples (see src/debug): there are none, and no launch arguments. */
object StoriesDemo {
  const val present = false

  @Suppress("UNUSED_PARAMETER")
  fun profile(own: Boolean): ProfilePostsData? = null

  @Suppress("UNUSED_PARAMETER")
  fun dress(viewer: StoryViewer) {}
}
