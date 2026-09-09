package com.openmausbot.companion.storage

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The one durable switch for "keep the stream open even when the app is not
 * on screen" — off by default, since it trades a persistent notification and
 * some battery for notifications that survive the app being fully closed.
 *
 * Read synchronously at process start ([OpenMausApp.onCreate]) so the boot
 * receiver and the always-on service can decide whether to run before any
 * Activity exists. `commit()`, not `apply()`: the toggle in Settings starts or
 * stops [com.openmausbot.companion.lifecycle.AlwaysOnConnectionService] right
 * after writing, and that decision must see the value that was just written,
 * not a write still queued for a background thread.
 */
class AlwaysOnPreferences(private val prefs: SharedPreferences) {

    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE),
    )

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /** @return false when the write failed — callers must not act as if it took. */
    fun setEnabled(value: Boolean): Boolean {
        if (_enabled.value == value) return true
        val saved = prefs.edit().putBoolean(KEY_ENABLED, value).commit()
        if (saved) _enabled.value = value
        return saved
    }

    companion object {
        const val NAME = "openmaus.always_on"
        const val KEY_ENABLED = "enabled"
    }
}
