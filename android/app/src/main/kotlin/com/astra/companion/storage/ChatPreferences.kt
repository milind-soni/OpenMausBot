package com.astra.companion.storage

import android.content.Context
import android.content.SharedPreferences
import com.astra.companion.core.ActivityDetail
import com.astra.companion.core.QuickReply
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Phone-local controls for how a conversation is presented.
 *
 * These are intentionally separate from pairing and from the encrypted token
 * store: they are presentation choices, not capabilities of the paired
 * computer. One instance is placed in [CompanionEnvironment], so Settings and
 * an already-open chat observe the same values immediately.
 */
class ChatPreferences(
    private val prefs: SharedPreferences,
) {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE),
    )

    private val _activityDetail = MutableStateFlow(
        ActivityDetail.fromWire(prefs.getString(ACTIVITY_DETAIL, null)),
    )
    val activityDetail: StateFlow<ActivityDetail> = _activityDetail.asStateFlow()

    private val _quickReplies = MutableStateFlow(QuickReply.decode(prefs.getString(QUICK_REPLIES, "").orEmpty()))
    val quickReplies: StateFlow<List<QuickReply>> = _quickReplies.asStateFlow()

    fun setActivityDetail(detail: ActivityDetail) {
        if (_activityDetail.value == detail && prefs.contains(ACTIVITY_DETAIL)) return
        // The value is small and changed only from Settings. Commit makes a
        // selection durable before a process recreation can observe it.
        prefs.edit().putString(ACTIVITY_DETAIL, detail.wireValue).commit()
        _activityDetail.value = detail
    }

    fun setQuickReplies(replies: List<QuickReply>) {
        // An encoded empty list is meaningful: it hides the chip row. Do not
        // turn it into an absent key, which QuickReply.decode correctly treats
        // as a first-run default.
        val encoded = QuickReply.encode(replies)
        if (_quickReplies.value == replies && prefs.getString(QUICK_REPLIES, null) == encoded) return
        prefs.edit().putString(QUICK_REPLIES, encoded).commit()
        _quickReplies.value = replies
    }

    fun resetQuickReplies() = setQuickReplies(QuickReply.DEFAULTS)

    fun lastShareDestination(connectionId: String): String? =
        prefs.getString(destinationKey(connectionId), null)?.takeIf(String::isNotBlank)

    fun setLastShareDestination(connectionId: String, destinationId: String) {
        val key = destinationKey(connectionId)
        if (prefs.getString(key, null) == destinationId) return
        prefs.edit().putString(key, destinationId).commit()
    }

    companion object {
        const val NAME = "openmaus.chat-preferences"
        const val FILE = "$NAME.xml"
        private const val ACTIVITY_DETAIL = "companion.prefs.activityDetail"
        private const val QUICK_REPLIES = "companion.prefs.quickReplies"

        private fun destinationKey(connectionId: String): String =
            "share.last-destination.$connectionId"
    }
}
