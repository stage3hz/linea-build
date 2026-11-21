package com.linea.messenger.music

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.MainActivity
import com.linea.messenger.R
import java.io.File
import java.lang.ref.WeakReference

/** The sound itself: the platform's MediaPlayer (it plays https streams, HLS among them, and the files of the
 *  app's own folder — nothing more is needed here, so no other player library is added), with the system's
 *  audio focus: another app's sound or a call pauses the music; it comes back after a short interruption and
 *  stays paused after a lasting one; where the system asks to be quieter, it is. Pulling the headphones out
 *  pauses too. Main thread only. */
class MediaEngine(context: Context) : MusicEngine {
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val manager = app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
  private var player: MediaPlayer? = null
  private var prepared = false
  private var wanted = false
  private var stalled = false
  /** Paused by a short loss of the audio focus: the music comes back with the focus. */
  private var resumeOnGain = false
  private var held = false
  private var listening = false

  override var onState: (() -> Unit)? = null
  override var onEnded: (() -> Unit)? = null
  override var onFailed: (() -> Unit)? = null

  private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
    .setOnAudioFocusChangeListener({ change -> focusChanged(change) }, main).build()

  /** The headphones were pulled out (or their link dropped): the music does not go on through the speaker. */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && wanted) { resumeOnGain = false; pause() }
    }
  }

  override val playing: Boolean get() = wanted
  override val ready: Boolean get() = prepared
  override val waiting: Boolean get() = stalled
  override val position: Double get() = if (prepared) try { (player?.currentPosition ?: 0) / 1000.0 } catch (_: IllegalStateException) { 0.0 } else 0.0
  override val duration: Double get() = if (prepared) try { maxOf(0, player?.duration ?: 0) / 1000.0 } catch (_: IllegalStateException) { 0.0 } else 0.0

  private fun focusChanged(change: Int) {
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> {
        try { player?.setVolume(1f, 1f) } catch (_: IllegalStateException) {}
        if (resumeOnGain) { resumeOnGain = false; begin() }
      }
      // Quieter while something short speaks over the music (the system does this by itself where it can).
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> try { player?.setVolume(0.2f, 0.2f) } catch (_: IllegalStateException) {}
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { val was = wanted; halt(); resumeOnGain = was }
      AudioManager.AUDIOFOCUS_LOSS -> { resumeOnGain = false; held = false; halt() }
    }
    onState?.invoke()
  }

  private fun listen(on: Boolean) {
    if (on == listening) return
    listening = on
    try {
      if (!on) app.unregisterReceiver(noisy)
      else if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), Context.RECEIVER_NOT_EXPORTED)
      else app.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    } catch (_: Exception) { /* not registered */ }
  }

  override fun load(source: String, local: Boolean) {
    silence()
    val made = MediaPlayer()
    player = made
    try {
      made.setAudioAttributes(attributes)
      made.setOnPreparedListener { if (player === made) { prepared = true; if (wanted) try { made.start() } catch (_: IllegalStateException) {}; onState?.invoke() } }
      made.setOnCompletionListener { if (player === made && prepared) { wanted = false; listen(false); onEnded?.invoke() } }
      made.setOnErrorListener { _, _, _ -> if (player === made) { prepared = false; wanted = false; listen(false); onFailed?.invoke() }; true }
      made.setOnInfoListener { _, what, _ ->
        if (player === made && (what == MediaPlayer.MEDIA_INFO_BUFFERING_START || what == MediaPlayer.MEDIA_INFO_BUFFERING_END)) { stalled = what == MediaPlayer.MEDIA_INFO_BUFFERING_START; onState?.invoke() }
        false
      }
      made.setOnSeekCompleteListener { if (player === made) onState?.invoke() }
      if (local) made.setDataSource(source) else made.setDataSource(app, Uri.parse(source))
      made.prepareAsync()
    } catch (_: Exception) {
      // Told after the caller is done with its own steps.
      main.post { if (player === made) onFailed?.invoke() }
    }
  }

  private fun begin() {
    wanted = true
    listen(true)
    if (prepared) try { player?.start() } catch (_: IllegalStateException) {}
  }

  /** Stops the sound without giving the focus away. */
  private fun halt() {
    wanted = false
    listen(false)
    if (prepared) try { player?.takeIf { it.isPlaying }?.pause() } catch (_: IllegalStateException) {}
  }

  override fun play(): Boolean {
    resumeOnGain = false
    // Rooms (rooms/RoomMusic.kt): inside a room the phone's sound is the room's own (the microphone is open) — the
    // music plays alongside it and must not take it over.
    val inRoom = com.linea.messenger.rooms.RoomVoice.inside
    if (!held && !inRoom) held = manager?.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (!held && !inRoom) return false
    try { player?.setVolume(1f, 1f) } catch (_: IllegalStateException) {}
    begin()
    return true
  }

  override fun pause() {
    resumeOnGain = false
    halt()
  }

  override fun seek(seconds: Double) {
    if (!prepared) return
    try { player?.seekTo((seconds * 1000).toLong(), MediaPlayer.SEEK_CLOSEST) } catch (_: IllegalStateException) {}
  }

  override fun silence() {
    val gone = player
    player = null
    prepared = false
    stalled = false
    wanted = false
    listen(false)
    if (gone != null) {
      try { gone.reset() } catch (_: Exception) {}
      gone.release()
    }
  }

  override fun rest() {
    resumeOnGain = false
    if (held) manager?.abandonAudioFocusRequest(focusRequest)
    held = false
  }
}

/** The player's place on this device: where its library is kept, and what keeps the music going while the app
 *  is not on the screen. */
class MusicHost private constructor(context: Context) : MusicStore, MusicSurroundings {
  private val app = context.applicationContext
  private val prefs = app.getSharedPreferences("linea.music", Context.MODE_PRIVATE)
  /** The window the permission to show notifications is asked in. */
  private var window = WeakReference<Activity>(null)

  override fun read(): String? = prefs.getString(MusicPlayer.libraryKey, null)
  override fun write(text: String) { prefs.edit().putString(MusicPlayer.libraryKey, text).apply() }
  override val folder: File? get() = File(app.filesDir, "linea-music")

  override fun started() {
    askNotifications()
    // The service is started while the app is on the screen (the person has just chosen a track). Should the
    // system refuse it all the same, the music plays on without it for as long as the app lives.
    if (MusicService.running) return
    try { app.startForegroundService(Intent(app, MusicService::class.java)) } catch (_: Exception) { /* no service: the page is the player */ }
  }

  override fun stopped() {
    try { app.stopService(Intent(app, MusicService::class.java)) } catch (_: Exception) {}
  }

  /** Android 13 and later: showing a notification is the person's choice, asked once — at the moment they first
   *  start the music, never at the app's start. Refused: the music plays all the same (see `MusicService`). */
  private fun askNotifications() {
    if (Build.VERSION.SDK_INT < 33 || prefs.getBoolean(askedKey, false)) return
    val activity = window.get() ?: return
    if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    prefs.edit().putBoolean(askedKey, true).apply()
    try { activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0x4D55) } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    private const val askedKey = "linea.music.notifications-asked.v1"
    private var made: MusicHost? = null

    /** Gives the app's one player its engine, its store and its service (once), and remembers the window. */
    fun attach(context: Context): MusicPlayer {
      val host = made ?: MusicHost(context).also { made = it }
      (context as? Activity)?.let { host.window = WeakReference(it) }
      val player = MusicPlayer.shared
      if (!player.attached) player.attach(MediaEngine(context), host, host)
      return player
    }
  }
}

/** Keeps the music going while the app is not on the screen: a foreground service of the kind `mediaPlayback`
 *  with a media notification, and a media session through which the lock screen, the notification, a watch and
 *  a headset's buttons drive the player. It holds no sound itself — that is `MusicPlayer.shared` — and ends
 *  with the player (`stop`).
 *
 *  Notifications refused (Android 13 and later): the service still runs in the foreground and the music plays;
 *  by the platform's documented rules the service is then listed in the system's «active apps» panel instead of
 *  showing its notification, and media controls that belong to a media session are exempt from the permission. */
class MusicService : Service() {
  private val player get() = MusicPlayer.shared
  private var session: MediaSession? = null
  private var foreground = false
  private var mark = ""
  private val changed: () -> Unit = { update() }
  private val coverReady: (String) -> Unit = { id -> if (id == player.current?.id) update() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    // Quiet: no sound, no vibration, no badge — it is only the player's controls.
    manager?.createNotificationChannel(NotificationChannel(channel, "Музыка", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false); description = "Плеер: что играет и кнопки управления" })
    val made = MediaSession(this, "invizent.music")
    made.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = player.setPlaying(true)
      override fun onPause() = player.setPlaying(false)
      override fun onSkipToNext() = player.next()
      override fun onSkipToPrevious() = player.previous()
      override fun onSeekTo(position: Long) = player.seek(position / 1000.0)
      override fun onStop() = player.stop()
    })
    made.setSessionActivity(openApp())
    session = made
    player.changed.watch(changed)
    MusicCovers.ready.watch(coverReady)
    running = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      actionToggle -> player.togglePlayback()
      actionNext -> player.next()
      actionPrevious -> player.previous()
      actionStop -> player.stop()
    }
    // Started by the player itself (no action): the system expects the service in the foreground at once,
    // whatever has become of the track meanwhile.
    update(obliged = intent?.action == null)
    // Nothing to play (the player was closed, or the system brought the service back without the app): it ends.
    if (player.current == null) {
      try { getSystemService(NotificationManager::class.java)?.cancel(notificationId) } catch (_: Exception) {}
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    player.changed.unwatch(changed)
    MusicCovers.ready.unwatch(coverReady)
    session?.isActive = false
    session?.release()
    session = null
    super.onDestroy()
  }

  /** The app was swiped away from the recent apps: music that is playing plays on (the notification and the
   *  lock screen still drive it, a touch on the notification opens the app again); a paused player ends. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (player.playing || player.loading) return
    player.stop()
    stopSelf()
  }

  private fun openApp(): PendingIntent =
    PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun command(action: String, code: Int): PendingIntent =
    PendingIntent.getService(this, code, Intent(this, MusicService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun button(icon: Int, words: String, action: String, code: Int): Notification.Action =
    Notification.Action.Builder(Icon.createWithResource(this, icon), words, command(action, code)).build()

  private fun enterForeground(notification: Notification) {
    // Asked while the app is on the screen, or by the person's own press on the notification or a headset.
    // Should the system refuse all the same, the notification is shown as an ordinary one and the music plays on.
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(notificationId, notification)
      foreground = true
    } catch (_: Exception) {
      show(notification)
    }
  }

  private fun show(notification: Notification) {
    try { getSystemService(NotificationManager::class.java)?.notify(notificationId, notification) } catch (_: Exception) { /* notifications are off */ }
  }

  private fun base(): Notification.Builder = Notification.Builder(this, channel).setSmallIcon(R.drawable.ic_music_note).setContentIntent(openApp())
    .setVisibility(Notification.VISIBILITY_PUBLIC).setCategory(Notification.CATEGORY_TRANSPORT).setOnlyAlertOnce(true).setShowWhen(false)

  /** `obliged`: the service was just started as a foreground one, and must become one now. */
  private fun update(obliged: Boolean = false) {
    val track = player.current
    val session = session
    if (track == null || session == null) {
      session?.isActive = false
      if (obliged && !foreground) enterForeground(base().setContentTitle("Музыка").build())
      if (foreground) { foreground = false; stopForeground(STOP_FOREGROUND_REMOVE) }
      return
    }
    val playing = player.playing
    val active = playing || player.loading
    val cover = MusicCovers.image(track)
    // The position moves by itself between two words of the player: the session is told again only when
    // something else has changed.
    val next = "${track.id}|$playing|${player.loading}|${player.queue.size}|${cover != null}|${Math.round(player.duration)}|${player.error.isNotEmpty()}"
    if (next == mark && !obliged) return
    mark = next
    val length = player.duration
    val data = MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, track.title).putString(MediaMetadata.METADATA_KEY_ARTIST, track.artist)
    if (length > 0) data.putLong(MediaMetadata.METADATA_KEY_DURATION, (length * 1000).toLong())
    if (cover != null) data.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover)
    session.setMetadata(data.build())
    var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP
    if (player.queue.size >= 2) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT
    val state = if (player.loading) PlaybackState.STATE_BUFFERING else if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
    session.setPlaybackState(PlaybackState.Builder().setActions(actions).setState(state, (player.position * 1000).toLong(), if (playing && !player.loading) 1f else 0f, SystemClock.elapsedRealtime()).build())
    session.isActive = true

    val builder = base()
      .setContentTitle(track.title).setContentText(track.artist)
      .setDeleteIntent(command(actionStop, 4)).setOngoing(active)
      .addAction(button(R.drawable.ic_music_previous, "Предыдущий трек или начало текущего", actionPrevious, 1))
      .addAction(button(if (playing) R.drawable.ic_music_pause else R.drawable.ic_music_play, if (playing) "Пауза" else "Слушать", actionToggle, 2))
      .addAction(button(R.drawable.ic_music_next, "Следующий трек", actionNext, 3))
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    if (cover != null) builder.setLargeIcon(cover)
    val notification = builder.build()
    if (active || obliged) enterForeground(notification)
    if (!active) {
      // Paused: the service leaves the foreground and the notification stays, now one that can be swiped away
      // (which closes the player).
      if (foreground) { stopForeground(STOP_FOREGROUND_DETACH); foreground = false }
      show(notification)
    }
  }

  companion object {
    /** The service is alive (it then follows the player by itself). Main thread only. */
    var running = false
      private set
    private const val channel = "music"
    private const val notificationId = 0x4D55
    private const val actionToggle = "com.linea.messenger.music.TOGGLE"
    private const val actionNext = "com.linea.messenger.music.NEXT"
    private const val actionPrevious = "com.linea.messenger.music.PREVIOUS"
    private const val actionStop = "com.linea.messenger.music.STOP"
  }
}
