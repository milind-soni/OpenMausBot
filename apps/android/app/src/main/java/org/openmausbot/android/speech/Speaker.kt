package org.openmausbot.android.speech

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

/** Replies read aloud with the phone's own voice. The desktop app offers
 *  ElevenLabs and other cloud voices; a phone that is away from the computer
 *  uses the engine Android already ships, offline. */
class Speaker(context: Context) {
    private var engine: TextToSpeech? = null
    private var ready = false
    private val appContext = context.applicationContext

    private fun ensure(): TextToSpeech? {
        if (engine == null) {
            engine = TextToSpeech(appContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                engine?.language = Locale.getDefault()
            }
        }
        return engine?.takeIf { ready }
    }

    fun speak(text: String) {
        val clean = stripForSpeech(text)
        if (clean.isBlank()) return
        val tts = ensure() ?: return
        tts.stop()
        tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "omb-reply")
    }

    fun stop() {
        engine?.stop()
    }

    fun release() {
        engine?.shutdown()
        engine = null
        ready = false
    }

    /** Code fences and table pipes read terribly; the spoken form keeps the
     *  words and drops the syntax. */
    private fun stripForSpeech(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```"), " ")
        .replace(Regex("`([^`]*)`"), "$1")
        .replace(Regex("!?\\[([^\\]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("[#>*_~|]"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
}
