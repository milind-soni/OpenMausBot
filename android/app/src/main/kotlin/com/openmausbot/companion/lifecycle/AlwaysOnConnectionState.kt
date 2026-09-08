package com.openmausbot.companion.lifecycle

/**
 * Whether [AlwaysOnConnectionService] is currently the reason the stream stays
 * open. [SessionLingerController.onStop] reads this before starting its own
 * 25-second window; when it is true the linger window is skipped entirely —
 * the service is already holding the process out of the cached class for as
 * long as the user left always-on enabled, so a 25-second timer racing it
 * would only ever be redundant or, on the service's own `onDestroy`, premature.
 *
 * Both the write (service `onCreate`/`onDestroy`) and the read
 * ([SessionLingerController], installed on `ProcessLifecycleOwner`) happen on
 * the main thread, matching [SessionLingerController]'s own "main-thread
 * confined" invariant — no lock needed.
 */
object AlwaysOnConnectionState {
    var active: Boolean = false
        internal set
}
