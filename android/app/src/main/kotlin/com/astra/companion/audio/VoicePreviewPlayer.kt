package com.astra.companion.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaDataSource
import android.media.MediaPlayer
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Plays one TTS preview at a time.
 *
 * Behaviour mirrors `AgentProfileView.previewVoice` on iOS (playback + spoken
 * audio, replace previous player, surface decode/play failures as an action
 * error string). Android lifecycle adds three hard stops the SwiftUI `@State`
 * player gets for free:
 * 1. another [play] replaces the current one;
 * 2. the bound screen lifecycle reaches [Lifecycle.Event.ON_DESTROY], or the
 *    screen owner is replaced via [bind];
 * 3. the process goes to background via [ProcessLifecycleOwner].
 *
 * The player is **not** retained across configuration changes: bind it to the
 * profile screen's [LifecycleOwner] and release on destroy so a rotated
 * Activity cannot keep a MediaPlayer from the previous instance.
 *
 * Audio bytes stay in memory (`MediaDataSource`); nothing is written to disk.
 */
class VoicePreviewPlayer internal constructor(
    private val controller: VoicePreviewController,
    processLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
) : DefaultLifecycleObserver {

    /**
     * Production constructor: builds a [MediaPlayerPreviewEngine] and
     * [AudioFocusGate] from [context].
     */
    constructor(
        context: Context,
        processLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
    ) : this(
        controller = VoicePreviewController(
            engineFactory = { MediaPlayerPreviewEngine() },
            focus = AudioFocusGate(context.applicationContext),
        ),
        processLifecycle = processLifecycle,
    )

    private val screenLifecycle = AtomicReference<Lifecycle?>(null)

    val playing: StateFlow<Boolean> = controller.playing

    /** Late decode/playback failures after a successful [play] return. */
    val playbackErrors: SharedFlow<String> = controller.playbackErrors

    init {
        processLifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                controller.onAppBackgrounded()
            }
        })
    }

    /**
     * Attach to the profile screen. Replaces any previous screen bind and
     * stops any in-flight preview so audio cannot outlive the prior owner
     * (navigation swap or configuration change).
     *
     * Call from the composable that owns the preview button
     * (`DisposableEffect(Unit) { player.bind(lifecycleOwner); onDispose { player.unbind(lifecycleOwner) } }`).
     */
    fun bind(owner: LifecycleOwner) {
        val next = owner.lifecycle
        val previous = screenLifecycle.getAndSet(next)
        if (previous !== next) {
            previous?.removeObserver(this)
            if (previous != null) {
                controller.onScreenDestroyed()
            }
            next.addObserver(this)
        }
    }

    fun unbind(owner: LifecycleOwner) {
        val current = owner.lifecycle
        if (screenLifecycle.compareAndSet(current, null)) {
            current.removeObserver(this)
            controller.onScreenDestroyed()
        }
    }

    /**
     * Start previewing [data]. Stops any current preview first.
     * @return null on success, or the iOS action-error copy on synchronous failure.
     * Asynchronous failures after start are emitted on [playbackErrors].
     */
    fun play(data: ByteArray): String? = controller.play(data)

    fun stop() {
        controller.stop()
    }

    override fun onDestroy(owner: LifecycleOwner) {
        if (screenLifecycle.compareAndSet(owner.lifecycle, null)) {
            owner.lifecycle.removeObserver(this)
            controller.onScreenDestroyed()
        }
    }
}

/**
 * Pure playback state machine — unit-tested without MediaPlayer.
 *
 * Transitions pinned to the iOS / PORT13 contract:
 * Idle → Playing on successful [play];
 * Playing → Playing on a replacing [play] (previous engine released first);
 * Playing → Idle on [stop], [onScreenDestroyed], [onAppBackgrounded],
 *           or audio-focus loss;
 * failure → Idle with [PLAYBACK_ERROR] (sync return or [playbackErrors]).
 *
 * All start/replace/complete/error transitions are serialized on [lock] and
 * tagged with a generation so a stale callback cannot resurrect a replaced
 * preview or leave a second MediaPlayer alive.
 */
class VoicePreviewController(
    private val engineFactory: () -> PreviewAudioEngine,
    private val focus: PreviewAudioFocus,
) {
    private val lock = Any()
    private var engine: PreviewAudioEngine? = null
    private var generation: Int = 0
    private val _playing = MutableStateFlow(false)
    private val _playbackErrors = MutableSharedFlow<String>(extraBufferCapacity = 1)

    val playing: StateFlow<Boolean> = _playing.asStateFlow()
    val playbackErrors: SharedFlow<String> = _playbackErrors.asSharedFlow()

    fun play(data: ByteArray): String? = synchronized(lock) {
        stopInternal(abandonFocus = true)
        if (!focus.request(onInterrupted = ::onFocusInterrupted)) {
            focus.abandon()
            _playing.value = false
            return PLAYBACK_ERROR
        }
        val next = engineFactory()
        val gen = generation + 1
        generation = gen
        // Install callbacks BEFORE start: the engine prepares/starts inside
        // start() and may deliver an immediate error before start() returns.
        // Assigning handlers afterward can drop that error.
        next.onCompletion = {
            synchronized(lock) {
                if (gen != generation) return@synchronized
                stopInternal(abandonFocus = true)
            }
        }
        next.onError = {
            synchronized(lock) {
                if (gen != generation) return@synchronized
                stopInternal(abandonFocus = true)
                _playbackErrors.tryEmit(PLAYBACK_ERROR)
            }
        }
        return try {
            val started = next.start(data)
            // If onError ran synchronously inside start(), stopInternal already
            // bumped [generation] while [engine] was still null — do not publish.
            if (!started || gen != generation) {
                next.release()
                focus.abandon()
                engine = null
                _playing.value = false
                if (!started) PLAYBACK_ERROR else null
            } else {
                engine = next
                _playing.value = true
                null
            }
        } catch (_: Exception) {
            next.release()
            focus.abandon()
            engine = null
            _playing.value = false
            PLAYBACK_ERROR
        }
    }

    fun stop() = synchronized(lock) { stopInternal(abandonFocus = true) }

    fun onScreenDestroyed() = synchronized(lock) { stopInternal(abandonFocus = true) }

    fun onAppBackgrounded() = synchronized(lock) { stopInternal(abandonFocus = true) }

    /**
     * Any focus loss / duck ends the preview. Short spoken clips are not
     * resumed — matching iOS tearing down the player when the session is
     * interrupted rather than ducking under other audio.
     */
    private fun onFocusInterrupted() {
        synchronized(lock) {
            stopInternal(abandonFocus = true)
        }
    }

    private fun stopInternal(abandonFocus: Boolean) {
        val current = engine
        engine = null
        // Bump so an in-flight completion/error from [current] is ignored.
        generation += 1
        val hadPlayback = current != null
        current?.stop()
        current?.release()
        if (abandonFocus && hadPlayback) focus.abandon()
        _playing.value = false
    }

    companion object {
        /** `AgentProfileView.previewVoice` failure copy. */
        const val PLAYBACK_ERROR: String = "The generated audio could not be played."
    }
}

interface PreviewAudioEngine {
    var onCompletion: (() -> Unit)?
    /** Asynchronous decode/playback failure after a successful [start]. */
    var onError: (() -> Unit)?
    fun start(data: ByteArray): Boolean
    fun stop()
    fun release()
}

interface PreviewAudioFocus {
    /**
     * Request exclusive transient focus for spoken preview.
     * [onInterrupted] runs on `LOSS`, `LOSS_TRANSIENT`, or
     * `LOSS_TRANSIENT_CAN_DUCK` — the controller must stop and abandon.
     */
    fun request(onInterrupted: () -> Unit): Boolean
    fun abandon()
}

internal class AudioFocusGate(
    context: Context,
) : PreviewAudioFocus {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null

    private val attributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    override fun request(onInterrupted: () -> Unit): Boolean {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes)
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener { change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS,
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
                    -> onInterrupted()
                }
            }
            .build()
        focusRequest = request
        return audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    override fun abandon() {
        val request = focusRequest ?: return
        focusRequest = null
        audioManager.abandonAudioFocusRequest(request)
    }
}

/**
 * MediaPlayer backed by an in-memory [MediaDataSource] — no cache file.
 * Attributes match iOS `.playback` + `.spokenAudio`.
 */
internal class MediaPlayerPreviewEngine : PreviewAudioEngine {
    override var onCompletion: (() -> Unit)? = null
    override var onError: (() -> Unit)? = null
    private var player: MediaPlayer? = null

    override fun start(data: ByteArray): Boolean {
        val mediaPlayer = MediaPlayer()
        player = mediaPlayer
        mediaPlayer.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        mediaPlayer.setDataSource(ByteArrayMediaDataSource(data))
        mediaPlayer.setOnCompletionListener {
            onCompletion?.invoke()
        }
        mediaPlayer.setOnErrorListener { _, _, _ ->
            onError?.invoke()
            true
        }
        mediaPlayer.prepare()
        mediaPlayer.start()
        return true
    }

    override fun stop() {
        runCatching {
            player?.let {
                if (it.isPlaying) it.stop()
            }
        }
    }

    override fun release() {
        runCatching { player?.release() }
        player = null
        onCompletion = null
        onError = null
    }
}

internal class ByteArrayMediaDataSource(
    private val data: ByteArray,
) : MediaDataSource() {
    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (position >= data.size) return -1
        val length = minOf(size, data.size - position.toInt())
        System.arraycopy(data, position.toInt(), buffer, offset, length)
        return length
    }

    override fun getSize(): Long = data.size.toLong()

    override fun close() = Unit
}
