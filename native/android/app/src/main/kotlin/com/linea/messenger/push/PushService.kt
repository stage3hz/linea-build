package com.linea.messenger.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * What Firebase Cloud Messaging hands the app (not exported: only Google Play services' own delivery reaches it,
 * through Firebase's receiver).
 *
 * - A chat notification while the app runs in the background is shown by the system itself, on the channel the server
 *   names (`messages`, `calls`, `calls-ring`, `silent`); tapped, it opens the window with the chat's id (Push.tapped).
 *   When the app's process is in front of it the system hands it here instead: Push.present.
 * - A call to a closed app comes as a data message that wakes the app: the full-screen ringing (Push.wake).
 * - A new token is registered for the signed-in session.
 */
class PushService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    Push.register(token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val shown = message.notification
    if (shown == null) {
      if (data["wake"] == "1") Push.wake(applicationContext, data)
      return
    }
    Push.present(applicationContext, shown.title ?: "INVIZENT", shown.body ?: "Новое сообщение", shown.channelId, shown.tag, data)
  }
}
