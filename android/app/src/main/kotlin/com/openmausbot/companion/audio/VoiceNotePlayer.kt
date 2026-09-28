package com.openmausbot.companion.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One voice note from the transcript, as the bubble sees it.
 *
 * [durationMs] is the engine's measured length once prepared; until then it is
 * null and the bubble shows the wire's estimate (or `--:--`), exactly like the
 * desktop bubble's `durationMs`-before-`onLoadedMetadata` window.
 */
data class VoiceNotePlayback(
    /** Row-unique identity: `message.id:path` — two rows may share a path. */
    val key: String,
    val playing: Boolean,
    val positionMs: Long,
    val durationMs: Long?,
)

/**
 * A late playback failure for one clip. Keyed so only the failing bubble
 * shows its retry row — a bare string would mark every visible note dead.
 */
data class VoiceNotePlaybackError(val key: String)

/**
 * Plays one transcript voice note at a time — the audio-bubble half of the
 * desktop `VoiceNoteBubble` contract (#1744, B3 in #1801).
 *
 * Unlike [VoicePreviewPlayer] this player is app-scoped, not screen-bound:
 * a note keeps playing while its row scrolls away, and pause keeps the
 * position so the same button resumes in place. The one-voice rule rides the
 * same [AudioFocusGate] the TTS preview uses, so a preview (or another note)
 * interrupts by pausing, never by talking over it.
 */
class VoiceNotePlayer internal constructor(
    private val controller: VoiceNoteController,
    processLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
) : DefaultLifecycleObserver {

    /** Production constructor: a [MediaPlayerVoiceNoteEngine] plus the shared focus gate. */
    constructor(
        context: Context,
        processLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
    ) : this(
        controller = VoiceNoteController(
            engineFactory = { MediaPlayerVoiceNoteEngine() },
            focus = AudioFocusGate(context.applicationContext),
        ),
        processLifecycle = processLifecycle,
    )

    val playback: StateFlow<VoiceNotePlayback?> get() = controller.playback

    /** Late decode/playback failures after a successful [play] return. */
    val playbackErrors: SharedFlow<VoiceNotePlaybackError> get() = controller.playbackErrors

    init {
        processLifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                controller.onAppBackgrounded()
            }
        })
    }

    /**
     * Start [key] from its beginning. Any note already playing is released
     * first (the one-voice rule: the newcomer takes the window's voice).
     * @return null on success, or failure copy for the bubble's retry row.
     */
    fun play(key: String, data: ByteArray): String? = controller.play(key, data)

    /** Pause in place: the position survives and focus is handed back. */
    fun pause() = controller.pause()

    /** Continue the paused note from its position, re-claiming focus. */
    fun resume(): String? = controller.resume()

    /** Whether [resume] can continue [key], or whether it must [play] again. */
    fun resumable(key: String): Boolean = controller.resumable(key)

    /** Move the clip; allowed while paused or playing, like `audio.currentTime`. */
    fun seek(key: String, positionMs: Long) = controller.seek(key, positionMs)

    /** Pull the engine's current position into [playback]; the bubble ticks this. */
    fun refresh() = controller.refresh()
}

/**
 * Pure playback state machine — unit-tested without MediaPlayer.
 *
 * Transitions pinned to the desktop `VoiceNoteBubble` contract:
 * Idle → Playing on successful [play]; a replacing [play] releases the old
 * engine first; [pause] keeps the position and gives the voice back;
 * [resume] re-claims; [seek] moves the clip; completion parks the clip at
 * its end (playing = false, engine released) so play restarts from zero;
 * focus loss and app background pause rather than stop. Failures surface
 * [PLAYBACK_ERROR] — synchronously from [play]/[resume], asynchronously on
 * [playbackErrors].
 *
 * All transitions are serialized on [lock] and generation-guarded so a stale
 * engine callback cannot resurrect a replaced note or leak a MediaPlayer.
 */
class VoiceNoteController(
    private val engineFactory: () -> VoiceNoteEngine,
    private val focus: PreviewAudioFocus,
) {
    private val lock = Any()
    private var engine: VoiceNoteEngine? = null
    private var generation = 0
    private val _playback = MutableStateFlow<VoiceNotePlayback?>(null)
    private val _playbackErrors = MutableSharedFlow<VoiceNotePlaybackError>(extraBufferCapacity = 1)

    val playback: StateFlow<VoiceNotePlayback?> = _playback.asStateFlow()
    val playbackErrors: SharedFlow<VoiceNotePlaybackError> = _playbackErrors.asSharedFlow()

    fun play(key: String, data: ByteArray): String? = synchronized(lock) {
        releaseInternal(abandonFocus = true)
        if (!focus.request(onInterrupted = ::onFocusInterrupted)) {
            focus.abandon()
            return PLAYBACK_ERROR
        }
        val next = engineFactory()
        val gen = generation + 1
        generation = gen
        // Install callbacks BEFORE start: the engine prepares inside start()
        // and may deliver completion or error before start() returns.
        next.onCompletion = {
            synchronized(lock) {
                if (gen != generation) return@synchronized
                // Desktop's onEnded: stopped, voice given back, clock left at the end.
                releaseInternal(abandonFocus = true, keepParkedState = true)
            }
        }
        next.onError = {
            synchronized(lock) {
                if (gen != generation) return@synchronized
                releaseInternal(abandonFocus = true)
                // The key rides with the failure so only this clip's bubble reacts.
                _playbackErrors.tryEmit(VoiceNotePlaybackError(key))
            }
        }
        return try {
            val started = next.start(data, startPositionMs = 0L)
            // If onError ran synchronously inside start(), releaseInternal already
            // bumped [generation] past [gen] — do not publish a dead engine.
            if (!started || gen != generation) {
                next.release()
                focus.abandon()
                _playback.value = null
                if (!started) PLAYBACK_ERROR else null
            } else {
                engine = next
                _playback.value = VoiceNotePlayback(
                    key = key,
                    playing = true,
                    positionMs = 0L,
                    durationMs = durationOf(next),
                )
                null
            }
        } catch (_: Exception) {
            next.release()
            focus.abandon()
            _playback.value = null
            PLAYBACK_ERROR
        }
    }

    fun pause() = synchronized(lock) { pauseInternal() }

    fun resume(): String? = synchronized(lock) {
        val state = _playback.value ?: return null
        val current = engine ?: return null
        if (state.playing) return null
        if (!focus.request(onInterrupted = ::onFocusInterrupted)) {
            focus.abandon()
            return PLAYBACK_ERROR
        }
        return try {
            current.resume()
            _playback.value = state.copy(playing = true, positionMs = positionOf(current, state.positionMs))
            null
        } catch (_: Exception) {
            releaseInternal(abandonFocus = true)
            PLAYBACK_ERROR
        }
    }

    fun resumable(key: String): Boolean = synchronized(lock) {
        val state = _playback.value
        state != null && state.key == key && !state.playing && engine != null
    }

    fun seek(key: String, positionMs: Long) = synchronized(lock) {
        val state = _playback.value ?: return
        if (state.key != key) return
        val duration = state.durationMs
        val target = positionMs.coerceIn(0L, duration?.takeIf { it > 0 }?.let { it - 1 } ?: Long.MAX_VALUE)
        val current = engine
        if (current == null) {
            _playback.value = state.copy(positionMs = target)
            return
        }
        try {
            current.seekTo(target)
            _playback.value = state.copy(positionMs = positionOf(current, target))
        } catch (_: Exception) {
            _playback.value = state.copy(positionMs = target)
        }
    }

    fun refresh() = synchronized(lock) {
        val state = _playback.value ?: return
        val current = engine ?: return
        if (!state.playing) return
        val position = current.positionMs()
        if (position >= 0) {
            _playback.value = state.copy(positionMs = position)
        }
    }

    fun onAppBackgrounded() = synchronized(lock) { pauseInternal() }

    /**
     * Any focus loss / duck pauses the note in place — the desktop contract
     * pauses the element when the speaker's voice is claimed elsewhere.
     */
    private fun onFocusInterrupted() {
        synchronized(lock) { pauseInternal() }
    }

    private fun pauseInternal() {
        val state = _playback.value ?: return
        val current = engine
        if (current == null) {
            if (state.playing) _playback.value = state.copy(playing = false)
            return
        }
        try {
            current.pause()
            _playback.value = state.copy(
                playing = false,
                positionMs = positionOf(current, state.positionMs),
            )
        } catch (_: Exception) {
            // A pause that cannot be delivered is a dead engine: release to idle.
            releaseInternal(abandonFocus = true)
            return
        }
        focus.abandon()
    }

    private fun releaseInternal(abandonFocus: Boolean, keepParkedState: Boolean = false) {
        val current = engine
        engine = null
        // Bump so an in-flight completion/error from [current] is ignored.
        generation += 1
        current?.stop()
        current?.release()
        if (abandonFocus && current != null) focus.abandon()
        if (keepParkedState && current != null) {
            val state = _playback.value
            if (state != null) {
                _playback.value = state.copy(
                    playing = false,
                    positionMs = state.durationMs?.takeIf { it > 0 } ?: state.positionMs,
                )
            }
        } else if (!keepParkedState) {
            _playback.value = null
        }
    }

    private fun positionOf(current: VoiceNoteEngine, fallback: Long): Long =
        current.positionMs().takeIf { it >= 0 } ?: fallback

    private fun durationOf(current: VoiceNoteEngine): Long? =
        current.durationMs().takeIf { it > 0 }

    companion object {
        /** Failure copy for the bubble's retry row. */
        const val PLAYBACK_ERROR: String = "The voice note could not be played."
    }
}

/** One playable clip; MediaPlayer in production, a fake in tests. */
interface VoiceNoteEngine {
    var onCompletion: (() -> Unit)?
    /** Asynchronous decode/playback failure after a successful [start]. */
    var onError: (() -> Unit)?
    /** Prepare and start from [startPositionMs]; false on synchronous failure. */
    fun start(data: ByteArray, startPositionMs: Long): Boolean
    fun pause()
    fun resume()
    fun seekTo(positionMs: Long)
    /** Current offset, or a negative value when the engine cannot say. */
    fun positionMs(): Long
    /** Measured length, or a negative value until metadata is loaded. */
    fun durationMs(): Long
    fun stop()
    fun release()
}

/**
 * MediaPlayer backed by the same in-memory [ByteArrayMediaDataSource] as the
 * TTS preview — voice-note bytes never touch disk.
 */
internal class MediaPlayerVoiceNoteEngine : VoiceNoteEngine {
    override var onCompletion: (() -> Unit)? = null
    override var onError: (() -> Unit)? = null
    private var player: MediaPlayer? = null

    override fun start(data: ByteArray, startPositionMs: Long): Boolean {
        val mediaPlayer = MediaPlayer()
        player = mediaPlayer
        mediaPlayer.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        mediaPlayer.setDataSource(ByteArrayMediaDataSource(data))
        mediaPlayer.setOnCompletionListener { onCompletion?.invoke() }
        mediaPlayer.setOnErrorListener { _, _, _ ->
            onError?.invoke()
            true
        }
        mediaPlayer.prepare()
        if (startPositionMs > 0) mediaPlayer.seekTo(startPositionMs.toInt())
        mediaPlayer.start()
        return true
    }

    override fun pause() {
        runCatching { player?.pause() }
    }

    override fun resume() {
        runCatching { player?.start() }
    }

    override fun seekTo(positionMs: Long) {
        runCatching { player?.seekTo(positionMs.toInt()) }
    }

    override fun positionMs(): Long = runCatching { player?.currentPosition?.toLong() ?: -1L }.getOrDefault(-1L)

    override fun durationMs(): Long = runCatching { player?.duration?.toLong() ?: -1L }.getOrDefault(-1L)

    override fun stop() {
        runCatching {
            player?.let { if (it.isPlaying) it.stop() }
        }
    }

    override fun release() {
        runCatching { player?.release() }
        player = null
        onCompletion = null
        onError = null
    }
}
