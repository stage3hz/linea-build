package com.linea.messenger.music

/** The release build's side of the music samples (see src/debug): there are none, and no launch arguments. */
object MusicDemo {
  val mode: String? get() = null
  val tracks: List<MusicTrack> get() = emptyList()
}
