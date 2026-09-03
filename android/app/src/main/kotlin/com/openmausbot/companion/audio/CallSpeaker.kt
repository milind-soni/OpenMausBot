package com.openmausbot.companion.audio

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Sequential playback of the utterances a call fetched from the computer —
 * `CallSpeaker` in `ios/App/CallView.swift`.
 *
 * One clip at a time, each awaited to its end, over the same MediaPlayer
 * engine and audio-focus gate the voice preview uses. [stop] — an interrupt
 * or a hang-up — bumps the generation so a `speak` in flight returns false
 * and whatever it was about to play never starts.
 */
class CallSpeaker internal constructor(
    private val engineFactory: () -> PreviewAudioEngine,
    private val focus: PreviewAudioFocus,
) {
    constructor(context: Context) : this(
        engineFactory = { MediaPlayerPreviewEngine() },
        focus = AudioFocusGate(context.applicationContext),
    )

    private val lock = Any()
    private var generation = 0
    private var engine: PreviewAudioEngine? = null
    private var finished: CompletableDeferred<Boolean>? = null

    private val _isSpeaking = MutableStateFlow(false)
    val isSpeaking: StateFlow<Boolean> = _isSpeaking.asStateFlow()

    /** Speak every clip in order. Returns false when stopped early. */
    suspend fun speak(clips: List<ByteArray>): Boolean {
        val mine = synchronized(lock) {
            stopLocked()
            generation += 1
            _isSpeaking.value = true
            generation
        }
        try {
            focus.request(onInterrupted = { stop() })
            for (clip in clips) {
                val done = CompletableDeferred<Boolean>()
                val started = synchronized(lock) {
                    if (generation != mine) return false
                    val next = engineFactory()
                    next.onCompletion = { done.complete(true) }
                    next.onError = { done.complete(false) }
                    engine = next
                    finished = done
                    runCatching { next.start(clip) }.getOrDefault(false)
                }
                if (!started) {
                    synchronized(lock) { releaseCurrentLocked() }
                    continue
                }
                done.await()
                synchronized(lock) {
                    if (generation != mine) return false
                    releaseCurrentLocked()
                }
            }
            return synchronized(lock) { generation == mine }
        } finally {
            synchronized(lock) {
                if (generation == mine) {
                    _isSpeaking.value = false
                    focus.abandon()
                }
            }
        }
    }

    fun stop() {
        synchronized(lock) {
            generation += 1
            stopLocked()
            _isSpeaking.value = false
            focus.abandon()
        }
    }

    private fun stopLocked() {
        engine?.stop()
        releaseCurrentLocked()
        finished?.complete(false)
        finished = null
    }

    private fun releaseCurrentLocked() {
        engine?.release()
        engine = null
    }
}
