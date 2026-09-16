package com.astra.companion.storage

import android.content.Context
import android.content.SharedPreferences
import com.astra.companion.core.OnboardingPreferenceKeys
import com.astra.companion.core.OnboardingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * The three durable onboarding markers, and nothing else — the Android shape of
 * the `@AppStorage` keys `RootView` reads in `ios/App/CompanionApp.swift` and
 * the `UserDefaults` key `Session.commit` writes.
 *
 * Three properties make this the right shape rather than an incidental one:
 *
 * - **It is one instance.** `Session` writes the pending marker from a
 *   background coroutine at the moment a pairing commits; the root router reads
 *   it to decide whether the education step is due. They are the same object, so
 *   the write is visible to the reader without anybody polling, and there is no
 *   second copy of the truth to drift.
 * - **It holds booleans, in a file of its own.** Nothing here is a secret and
 *   nothing here may become one (§6): the type system offers no way to put a
 *   credential in, the file is named for this purpose alone, and
 *   `OnboardingPreferencesContractTest` fails if a fourth key ever appears.
 * - **A write is durable before it returns.** [SharedPreferences.Editor.commit]
 *   rather than `apply()`, because [com.astra.companion.core.Session] puts
 *   this write *before* the connection save specifically so a process that stops
 *   in between cannot leave a restorable pairing whose marker never landed.
 *   `apply()` would hand that ordering back to a background thread and quietly
 *   undo the guarantee.
 *
 * Not backed up and not transferred, for the reason the permission bookkeeping
 * is not: these record what *this* install has already shown and spent.
 */
class OnboardingPreferences(
    private val prefs: SharedPreferences,
    /** Where the blocking read/write goes; overridden in tests. */
    private val io: kotlin.coroutines.CoroutineContext = Dispatchers.IO,
) : OnboardingStore {

    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE),
    )

    private val _welcomeSeen = MutableStateFlow(read(OnboardingPreferenceKeys.WELCOME_SEEN))
    private val _notificationPromptSeen =
        MutableStateFlow(read(OnboardingPreferenceKeys.NOTIFICATION_PROMPT_SEEN))
    private val _notificationPending =
        MutableStateFlow(read(OnboardingPreferenceKeys.PENDING_NOTIFICATION_ONBOARDING))

    /** The welcome has been answered — by connecting, or by "Not now". */
    val welcomeSeen: StateFlow<Boolean> = _welcomeSeen.asStateFlow()

    /** The notification education step has been answered, either way. */
    val notificationPromptSeen: StateFlow<Boolean> = _notificationPromptSeen.asStateFlow()

    /** A pairing committed and its education step has not been settled yet. */
    val notificationPending: StateFlow<Boolean> = _notificationPending.asStateFlow()

    override suspend fun notificationOnboardingPending(): Boolean = _notificationPending.value

    override suspend fun setNotificationOnboardingPending(pending: Boolean) {
        write(OnboardingPreferenceKeys.PENDING_NOTIFICATION_ONBOARDING, pending, _notificationPending)
    }

    suspend fun setWelcomeSeen(seen: Boolean) {
        write(OnboardingPreferenceKeys.WELCOME_SEEN, seen, _welcomeSeen)
    }

    suspend fun setNotificationPromptSeen(seen: Boolean) {
        write(OnboardingPreferenceKeys.NOTIFICATION_PROMPT_SEEN, seen, _notificationPromptSeen)
    }

    private fun read(key: String): Boolean = prefs.getBoolean(key, false)

    private suspend fun write(key: String, value: Boolean, into: MutableStateFlow<Boolean>) {
        // An unchanged value is not written. Every launch reconciles the pending
        // marker, and almost every launch reconciles it to the value already on
        // disk; committing that would be a synchronous disk write per launch for
        // no change at all.
        if (into.value == value && prefs.contains(key)) return
        withContext(io) { prefs.edit().putBoolean(key, value).commit() }
        into.value = value
    }

    companion object {
        const val NAME = "astra.onboarding"

        /** The on-disk file, named here so the backup rules can be asserted against it. */
        const val FILE = "$NAME.xml"
    }
}
