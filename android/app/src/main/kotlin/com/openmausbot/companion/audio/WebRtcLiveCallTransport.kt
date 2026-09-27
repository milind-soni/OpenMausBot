package com.openmausbot.companion.audio

import android.content.Context
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * libwebrtc (`io.github.webrtc-sdk:android`) behind [LiveCallTransport]. The
 * only file in the app that imports `org.webrtc`.
 *
 * Verified 2026-09-25 on the arm64 API 37 emulator: the library loads, the
 * offer carries an audio m-line and the `oai-events` channel, and ICE
 * gathering completes in milliseconds with no ICE servers (OpenAI's own
 * samples pass none). The voice's remote track plays through the audio device
 * module on its own; nothing here renders it.
 *
 * [close] can run while [offer] or [accept] waits on a native callback (a
 * hang-up during "Connecting…"); [guard] then fails the wait, so neither
 * touches the disposed peer.
 */
internal class WebRtcLiveCallTransport(context: Context) : LiveCallTransport {
    private val app = context.applicationContext
    private var adm: JavaAudioDeviceModule? = null
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null
    private var source: AudioSource? = null
    private var microphone: AudioTrack? = null
    private val guard = TransportCloseGuard()

    override suspend fun offer(listener: LiveCallTransport.Listener): String {
        // Closed before it began: build nothing that close() has already missed.
        guard.ensureOpen()
        initializeOnce()
        val deviceModule = JavaAudioDeviceModule.builder(app)
            // Hardware echo cancellation and noise suppression where the
            // device has them; libwebrtc's software AEC otherwise (emulators).
            .setUseHardwareAcousticEchoCanceler(JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported())
            .setUseHardwareNoiseSuppressor(JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported())
            .createAudioDeviceModule()
        adm = deviceModule
        val peerFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(deviceModule)
            .createPeerConnectionFactory()
        factory = peerFactory

        val gathered = CompletableDeferred<Unit>()
        val configuration = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = peerFactory.createPeerConnection(
            configuration,
            object : PeerConnection.Observer {
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                    if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
                }

                override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                    when (state) {
                        PeerConnection.PeerConnectionState.CONNECTED -> listener.onConnected()
                        PeerConnection.PeerConnectionState.FAILED,
                        PeerConnection.PeerConnectionState.CLOSED,
                        -> if (!guard.isClosed) listener.onDropped()
                        else -> Unit
                    }
                }

                override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
                override fun onIceCandidate(candidate: IceCandidate) = Unit
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
                override fun onAddStream(stream: MediaStream) = Unit
                override fun onRemoveStream(stream: MediaStream) = Unit
                override fun onDataChannel(channel: DataChannel) = Unit
                override fun onRenegotiationNeeded() = Unit
                override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
            },
        ) ?: error("createPeerConnection returned null")
        peer = connection

        val audioSource = peerFactory.createAudioSource(MediaConstraints())
        source = audioSource
        val track = peerFactory.createAudioTrack("mic0", audioSource)
        microphone = track
        connection.addTrack(track, listOf("omb"))

        // Before the offer, so the m=application section is negotiated.
        val events = connection.createDataChannel(LiveCallTransport.DATA_CHANNEL, DataChannel.Init())
        channel = events
        events.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) = Unit

            // close() unregisters this observer before it closes the channel,
            // so a channel this transport closed never reports here.
            override fun onStateChange() {
                if (events.state() == DataChannel.State.OPEN) listener.onChannelOpen()
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                listener.onMessage(Charsets.UTF_8.decode(buffer.data).toString())
            }
        })

        val created = CompletableDeferred<SessionDescription>()
        // Each wait below throws if close() ran meanwhile, before the peer is used again.
        val offer = guard.await(created) {
            connection.createOffer(
                object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        created.complete(description)
                    }

                    override fun onCreateFailure(reason: String?) {
                        created.completeExceptionally(IllegalStateException("createOffer failed: $reason"))
                    }

                    override fun onSetSuccess() = Unit
                    override fun onSetFailure(reason: String?) = Unit
                },
                MediaConstraints(),
            )
        }
        setDescription { observer -> connection.setLocalDescription(observer, offer) }
        // Non-trickle ICE: OpenAI takes one complete offer. With no ICE servers
        // this is quick; the timeout covers a phone whose network stalls.
        withTimeoutOrNull(LiveCallTransport.ICE_TIMEOUT_MS) { guard.await(gathered) }
        // A timeout returns without the guard's own check.
        guard.ensureOpen()
        return connection.localDescription?.description ?: offer.description
    }

    override suspend fun accept(answerSdp: String) {
        guard.ensureOpen()
        val connection = checkNotNull(peer) { "accept before offer" }
        setDescription { observer ->
            connection.setRemoteDescription(observer, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
        }
    }

    override fun setMuted(muted: Boolean) {
        microphone?.setEnabled(!muted)
    }

    override fun sendClose() {
        val events = channel ?: return
        if (events.state() != DataChannel.State.OPEN) return
        events.send(DataChannel.Buffer(ByteBuffer.wrap(CLOSE_EVENT.toByteArray(Charsets.UTF_8)), false))
    }

    override fun close() {
        if (!guard.close()) return
        channel?.let {
            it.unregisterObserver()
            it.close()
            it.dispose()
        }
        channel = null
        microphone?.dispose()
        microphone = null
        peer?.let {
            it.close()
            it.dispose()
        }
        peer = null
        // The track holds the source natively but never releases this handle
        // on it, so without this every call would leak one audio source.
        source?.dispose()
        source = null
        factory?.dispose()
        factory = null
        adm?.release()
        adm = null
        // Last: a waiter resumed by this finds everything already released.
        guard.failPending()
    }

    private suspend fun setDescription(apply: (SdpObserver) -> Unit) {
        val done = CompletableDeferred<Unit>()
        guard.await(done) {
            apply(object : SdpObserver {
                override fun onSetSuccess() {
                    done.complete(Unit)
                }

                override fun onSetFailure(reason: String?) {
                    done.completeExceptionally(IllegalStateException("setDescription failed: $reason"))
                }

                override fun onCreateSuccess(description: SessionDescription?) = Unit
                override fun onCreateFailure(reason: String?) = Unit
            })
        }
    }

    private fun initializeOnce() {
        if (initialized.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions(),
            )
        }
    }

    private companion object {
        const val CLOSE_EVENT = """{"type":"session.close"}"""

        /** `PeerConnectionFactory.initialize` is process-wide and must run once. */
        val initialized = AtomicBoolean(false)
    }
}
