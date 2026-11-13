package expo.modules.lineacall

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Android side of src/calls/systemCall.ts: the ongoing-call foreground service and its notification. */
class LineCallModule : Module() {
  private fun context(): Context? = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("LineaCall")
    Events("end", "mute", "audio", "open")

    OnCreate { CallService.listener = { event, id -> sendEvent(event, mapOf("id" to id)) } }
    OnDestroy { CallService.listener = null }

    Function("supported") { true }

    AsyncFunction("start") { id: String, name: String, _video: Boolean, text: String, endLabel: String, channelName: String ->
      val ctx = context() ?: return@AsyncFunction false
      CallService.start(ctx, CallService.Shown(id, name, text, endLabel, channelName, 0L))
    }

    AsyncFunction("update") { id: String, text: String, connectedAt: Double ->
      val ctx = context() ?: return@AsyncFunction
      CallService.update(ctx, id, text, connectedAt.toLong())
    }

    // The microphone state lives in the app on Android (the notification has no mute button).
    AsyncFunction("setMuted") { _id: String, _muted: Boolean -> }

    AsyncFunction("end") { id: String ->
      val ctx = context() ?: return@AsyncFunction
      CallService.stop(ctx, id)
    }

    // ---- An incoming call while the app is closed (IncomingCall.kt) ----
    // Shows the ringing, full-screen notification; false when the phone would not show it.
    AsyncFunction("showIncoming") { chatId: String, name: String, text: String, answerLabel: String, declineLabel: String, channelName: String ->
      val ctx = context() ?: return@AsyncFunction false
      IncomingCall.show(ctx, chatId, name, text, answerLabel, declineLabel, channelName)
    }
    AsyncFunction("dismissIncoming") { -> context()?.let { IncomingCall.dismiss(it) } }
    // What the app was opened for by that notification ({ chatId, answer }), once; null otherwise.
    Function("takeIncoming") { -> IncomingCall.take() }
    // The app over the lock screen: on while a call is on screen, off the moment it is left.
    AsyncFunction("setOverLock") { on: Boolean -> IncomingCall.overLock(appContext.currentActivity, on) }
    // Opened by the notification from a closed app (the activity is created with the extras)…
    OnActivityEntersForeground { appContext.currentActivity?.let { IncomingCall.opened(it, it.intent) } }

    // A tap on the notification brings the app back with the call id: the call screen opens.
    OnNewIntent { intent: Intent ->
      // …or brought back while it was running.
      IncomingCall.opened(appContext.currentActivity, intent)
      val id = intent.getStringExtra(CallService.EXTRA_OPEN) ?: return@OnNewIntent
      intent.removeExtra(CallService.EXTRA_OPEN)
      sendEvent("open", mapOf("id" to id))
    }
  }
}
