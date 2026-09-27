package com.openmausbot.companion.audio

import com.openmausbot.companion.core.LiveCallStart
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** The two calls and the reports a Live call needs from the computer. [Session] in production, a fake in tests. */
interface LiveCallApi {
    suspend fun start(botId: String, threadId: String, sdp: String): LiveCallStart

    suspend fun end(callId: String)

    /** The computer's current call as the `live.call` frames and `GET /api/live/call` report it. */
    val serverCall: Flow<LiveCallState?>

    /**
     * Which computer this phone follows, and whether its pairing still
     * stands. A call belongs to the computer it started on: losing the
     * pairing hangs it up, and switching computers leaves it behind.
     */
    val link: Flow<LiveCallLink>
}

/**
 * [computerId] is the paired computer's connection id, null while none is
 * selected; [signedIn] is false once the pairing is gone or its token is
 * refused (`Session.Status.Unpaired` or `Unauthorized`).
 */
data class LiveCallLink(val computerId: String?, val signedIn: Boolean)

internal class SessionLiveCallApi(private val session: Session) : LiveCallApi {
    override suspend fun start(botId: String, threadId: String, sdp: String): LiveCallStart =
        session.startLiveCall(botId, threadId, sdp)

    override suspend fun end(callId: String) {
        session.endLiveCall(callId)
    }

    override val serverCall: Flow<LiveCallState?> = session.state.map { it.liveCall }.distinctUntilChanged()

    override val link: Flow<LiveCallLink> = combine(session.connection, session.status) { connection, status ->
        LiveCallLink(
            computerId = connection?.id,
            signedIn = status !is Session.Status.Unpaired && status !is Session.Status.Unauthorized,
        )
    }.distinctUntilChanged()
}
