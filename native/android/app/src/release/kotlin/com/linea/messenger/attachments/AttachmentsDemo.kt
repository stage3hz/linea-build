package com.linea.messenger.attachments

import android.view.View

/** The release build's side of the attachment samples (see src/debug): no sample rows, no launch arguments. */
object AttachmentsDemo {
  fun rows(): List<Map<String, Any?>> = emptyList()

  @Suppress("UNUSED_PARAMETER")
  fun viewer(host: View) {}

  @Suppress("UNUSED_PARAMETER")
  fun opened(rows: List<Map<String, Any?>>, host: View, press: (String) -> Unit) {}

  /** Media: never drawn tiles in a release build. */
  @Suppress("UNUSED_PARAMETER")
  fun panelSamples(panel: AttachmentPanel): Boolean = false

  @Suppress("UNUSED_PARAMETER")
  fun media(attachments: ChatAttachments, host: View) {}
}
