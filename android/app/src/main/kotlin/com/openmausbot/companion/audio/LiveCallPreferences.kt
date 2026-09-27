package com.openmausbot.companion.audio

import android.content.Context
import android.content.SharedPreferences

/**
 * This phone's own Live call choices, kept across calls and launches. The
 * computer's settings (voice, typed replies, idle minutes) are shared and
 * live there; speaker or earpiece, and whether this phone already showed the
 * first-call disclosure, are the phone's alone, as on the iPhone.
 * Behind an interface so the manager's JVM tests need no SharedPreferences.
 */
interface LiveCallPreferences {
    /** The loudspeaker (true) or the earpiece (false) while no headset is connected. */
    var speaker: Boolean

    /**
     * This phone showed the first-call disclosure (what a Live call sends to
     * OpenAI) and the person chose Start call: it is not shown here again.
     */
    var disclosureShown: Boolean
}

/** [LiveCallPreferences] in app-private SharedPreferences, the way `ChatPreferences` keeps its choices. */
internal class SharedLiveCallPreferences(private val prefs: SharedPreferences) : LiveCallPreferences {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE),
    )

    override var speaker: Boolean
        get() = prefs.getBoolean(SPEAKER, true)
        set(value) {
            if (prefs.contains(SPEAKER) && prefs.getBoolean(SPEAKER, true) == value) return
            // Small and rare: commit, so the choice is on disk before the process can go.
            prefs.edit().putBoolean(SPEAKER, value).commit()
        }

    override var disclosureShown: Boolean
        get() = prefs.getBoolean(DISCLOSURE_SHOWN, false)
        set(value) {
            if (prefs.getBoolean(DISCLOSURE_SHOWN, false) == value) return
            prefs.edit().putBoolean(DISCLOSURE_SHOWN, value).commit()
        }

    private companion object {
        const val NAME = "live_call"
        const val SPEAKER = "speaker"
        const val DISCLOSURE_SHOWN = "disclosure_shown"
    }
}
