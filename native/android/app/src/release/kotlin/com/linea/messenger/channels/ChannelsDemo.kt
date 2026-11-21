package com.linea.messenger.channels

/** The release build's side of the samples of «Каналы» (see src/debug): there are none, and no launch arguments. */
object ChannelsDemo {
  const val present = false

  fun summaries(): List<CommunitySummary> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun community(id: String): Community? = null

  fun members(): List<CommunityMember> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun fill(engine: ChannelEngine, blog: Boolean) {}
}
