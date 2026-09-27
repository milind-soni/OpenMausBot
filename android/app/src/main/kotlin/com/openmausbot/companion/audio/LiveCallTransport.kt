package com.openmausbot.companion.audio

/**
 * The phone's media for one Live call: microphone in, the voice out, and the
 * `oai-events` data channel that carries captions. WebRTC in production
 * ([WebRtcLiveCallTransport]); a fake in tests. Nothing else in the app may
 * touch `org.webrtc`, so the JVM suite never loads its native library.
 *
 * One transport is one call: [offer] once, [accept] once, then [close].
 * `close()` may be called while `offer()`/`accept()` are suspended; both must
 * then fail quietly (throw, and touch no released media).
 */
interface LiveCallTransport {
    interface Listener {
        /** A text frame from the data channel, as OpenAI sent it (JSON). Called on a WebRTC thread. */
        fun onMessage(text: String)

        /** The peer connection reached CONNECTED. */
        fun onConnected()

        /**
         * The `oai-events` data channel opened: captions can arrive, and
         * since the channel rides the call's own connection, its audio got
         * through. With the computer's word that its side attached, the
         * call is live. Called on a WebRTC thread.
         */
        fun onChannelOpen()

        /** The peer connection failed or closed without [close] being called. */
        fun onDropped()
    }

    /**
     * Create the microphone track and the `oai-events` channel (before the
     * offer, as OpenAI requires), create the offer, gather ICE without
     * trickle, and return the local SDP. Waits at most [ICE_TIMEOUT_MS] for
     * gathering; what has gathered by then is sent.
     */
    suspend fun offer(listener: Listener): String

    /** Apply OpenAI's answer, unchanged. Throws when the SDP is rejected. */
    suspend fun accept(answerSdp: String)

    /** Local mute: the track stops sending; nothing is told to OpenAI. */
    fun setMuted(muted: Boolean)

    /** `{"type":"session.close"}` on the data channel — the one client event the harness allows. */
    fun sendClose()

    /** Release everything. Safe to call twice, and while [offer] or [accept] is suspended (they then throw). */
    fun close()

    companion object {
        const val ICE_TIMEOUT_MS = 10_000L
        const val DATA_CHANNEL = "oai-events"
    }
}

fun interface LiveCallTransportFactory {
    fun create(): LiveCallTransport
}
