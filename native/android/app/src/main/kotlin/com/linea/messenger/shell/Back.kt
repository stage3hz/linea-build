package com.linea.messenger.shell

import android.annotation.TargetApi
import android.app.Activity
import android.os.Build
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/** The system's Back on Android 13 and later (the predictive gesture): the app says in advance whether it has
 *  somewhere to go back to. While it has not, the system shows its own "leaving the app" motion; while it has,
 *  the gesture comes here — with its progress on Android 14 and later, so the page can follow the finger. */
@TargetApi(33)
class BackGate(private val activity: Activity, onBack: () -> Unit, onProgress: (Float) -> Unit, onCancel: () -> Unit) {
  private val callback: OnBackInvokedCallback =
    if (Build.VERSION.SDK_INT >= 34) Followed.make(onBack, onProgress, onCancel) else OnBackInvokedCallback { onBack() }
  private var on = false

  /** `wanted`: the app handles Back itself now. */
  fun set(wanted: Boolean) {
    if (wanted == on) return
    on = wanted
    val dispatcher = activity.onBackInvokedDispatcher
    if (wanted) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
    else dispatcher.unregisterOnBackInvokedCallback(callback)
  }
}

@TargetApi(34)
private object Followed {
  fun make(onBack: () -> Unit, onProgress: (Float) -> Unit, onCancel: () -> Unit): OnBackInvokedCallback = object : OnBackAnimationCallback {
    override fun onBackProgressed(backEvent: BackEvent) = onProgress(backEvent.progress)
    override fun onBackCancelled() = onCancel()
    override fun onBackInvoked() = onBack()
  }
}
