package org.openmausbot.android.e2e

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class SessionClosed(val code: Int) : Exception("e2e session closed ($code)")

/** One stream's consumer. The proxy's implementation only enqueues, so the
 *  WebSocket reader is never blocked by a slow phone-side socket. */
interface StreamSink {
    fun onData(data: ByteArray)
    fun onEnd()
    fun onReset()
}

/** The phone half of one encrypted session: handshake, record cipher and yamux.
 *  Every public method is safe to call from the WebSocket thread and from any
 *  stream thread; the mux and the send counter share one monitor. */
class PhoneSession(
    private val transport: RecordTransport,
    private val transportByte: Int,
    remoteStatic: ByteArray,
    psk: ByteArray,
    app: String,
    private val pingIntervalMs: Long = Yamux.PING_INTERVAL_MS,
    private val pingTimeoutMs: Long = Yamux.PING_TIMEOUT_MS,
    private val handshakeDeadlineMs: Long = HANDSHAKE_DEADLINE_MS,
    ephemeral: Crypto.P256KeyPair? = null,
) {
    enum class State { HANDSHAKE, OPEN, CLOSED }

    companion object {
        const val HANDSHAKE_DEADLINE_MS = 10_000L
        private val scheduler: ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "omb-e2e-timer").apply { isDaemon = true }
            }
    }

    @Volatile var state: State = State.HANDSHAKE
        private set
    @Volatile var removed: Boolean = false
        private set

    val ready = CompletableFuture<Unit>()
    val closed = CompletableFuture<Int>()
    var onClosed: ((Int) -> Unit)? = null

    private val gate = Object()
    private val streams = HashMap<Int, StreamSink>()
    private val conn = Noise.newConn()
    private val connText = B64u.encode(conn)
    private var hello: Noise.PhoneHello?
    private var keys: Noise.SessionKeys? = null
    private var mux: Yamux.Mux? = null
    private var deadline: ScheduledFuture<*>? = null
    private var pingTask: ScheduledFuture<*>? = null
    private var pongTask: ScheduledFuture<*>? = null
    private var awaitingPong: Int? = null
    private var pingCounter = 0

    init {
        val created = try {
            Noise.phoneHello(
                remoteStatic = remoteStatic,
                psk = psk,
                transport = transportByte,
                payload1 = Noise.encodePayload1(conn, app),
                conn = connText,
                ephemeral = ephemeral,
            )
        } catch (_: Exception) {
            null
        }
        hello = created
        if (created == null) {
            state = State.CLOSED
            ready.completeExceptionally(NoiseException("handshake_init"))
            closed.complete(4000)
        } else {
            deadline = scheduler.schedule(
                { close(4002) },
                handshakeDeadlineMs,
                TimeUnit.MILLISECONDS,
            )
            try {
                transport.send(created.message1)
            } catch (error: Exception) {
                close(1006, error.message ?: "send_failed")
            }
        }
    }

    fun awaitReady(timeoutMs: Long = HANDSHAKE_DEADLINE_MS + 2_000L) {
        try {
            ready.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: ExecutionException) {
            throw error.cause ?: error
        } catch (error: TimeoutException) {
            close(4002)
            throw SessionClosed(4002)
        }
    }

    /** Called by the WebSocket listener with one message, in arrival order. */
    @Synchronized
    fun receive(message: ByteArray, binary: Boolean) {
        when (state) {
            State.CLOSED -> return
            State.HANDSHAKE -> {
                if (!binary) {
                    close(4000)
                    return
                }
                val pending = hello ?: run {
                    close(4000)
                    return
                }
                hello = null
                val sessionKeys = try {
                    pending.finish(message)
                } catch (_: NoiseException) {
                    close(4000)
                    return
                }
                start(sessionKeys)
            }
            State.OPEN -> {
                if (!binary) {
                    close(4000)
                    return
                }
                val current = keys ?: run {
                    close(4000)
                    return
                }
                val plaintext = try {
                    current.receive.open(message)
                } catch (_: NoiseException) {
                    close(4000)
                    return
                }
                val frame = try {
                    Yamux.decodeFrame(plaintext)
                } catch (_: YamuxException) {
                    mux?.protocolError()
                    close(4000)
                    return
                }
                try {
                    mux?.receive(frame)
                } catch (_: YamuxException) {
                    mux?.protocolError()
                    close(4000)
                }
            }
        }
    }

    fun transportClosed(code: Int) {
        end(code)
    }

    @Synchronized
    fun openStream(sink: StreamSink): Int {
        val current = mux
        if (state != State.OPEN || current == null) throw SessionClosed(1000)
        val streamId = current.open()
        streams[streamId] = sink
        return streamId
    }

    @Synchronized
    fun write(streamId: Int, data: ByteArray): Int {
        if (state != State.OPEN) return 0
        return mux?.write(streamId, data) ?: 0
    }

    /** Sends all of `data`, waiting for window updates. False once the stream
     *  or the session is gone, so the caller can drop its socket. */
    fun writeAll(streamId: Int, data: ByteArray, cancelled: () -> Boolean = { false }): Boolean {
        var offset = 0
        while (offset < data.size) {
            if (cancelled()) return false
            val taken = synchronized(this) {
                val current = mux
                if (state != State.OPEN || current == null || !current.has(streamId)) {
                    return false
                }
                current.write(streamId, data.copyOfRange(offset, data.size))
            }
            if (taken > 0) {
                offset += taken
                continue
            }
            synchronized(gate) {
                if (state != State.OPEN || cancelled()) return false
                try {
                    gate.wait(200)
                } catch (_: InterruptedException) {
                    return false
                }
            }
        }
        return true
    }

    @Synchronized
    fun finish(streamId: Int) {
        mux?.finish(streamId)
    }

    @Synchronized
    fun reset(streamId: Int) {
        mux?.reset(streamId)
        streams.remove(streamId)
    }

    @Synchronized
    fun consumed(streamId: Int, bytes: Int) {
        if (bytes > 0) mux?.consumed(streamId, bytes)
    }

    @Synchronized
    fun sendWindow(streamId: Int): Int = mux?.sendWindow(streamId) ?: 0

    /** A planned close: GoAway first so the computer can distinguish it from a
     *  network failure, then 1000. */
    fun shutdown() {
        if (state == State.OPEN) mux?.goAway(Yamux.GO_AWAY_NORMAL)
        close(1000)
    }

    fun close(code: Int, reason: String = "") {
        if (state == State.CLOSED) return
        try {
            transport.close(code, reason)
        } catch (_: Exception) {
        }
        end(code)
    }

    private fun start(sessionKeys: Noise.SessionKeys) {
        deadline?.cancel(false)
        deadline = null
        keys = sessionKeys
        state = State.OPEN
        mux = Yamux.Mux("phone", object : Yamux.MuxEvents {
            override fun send(frame: Yamux.Frame) = sendFrame(frame)

            override fun data(streamId: Int, data: ByteArray) {
                val sink = synchronized(this@PhoneSession) { streams[streamId] }
                sink?.onData(data)
            }

            override fun ended(streamId: Int) {
                val sink = synchronized(this@PhoneSession) { streams[streamId] }
                sink?.onEnd()
            }

            override fun reset(streamId: Int) {
                val sink = synchronized(this@PhoneSession) { streams.remove(streamId) }
                sink?.onReset()
            }

            override fun writable(streamId: Int) {
                synchronized(gate) { gate.notifyAll() }
            }

            override fun goAway(code: Int) {
                if (code == Yamux.GO_AWAY_REMOVED) {
                    removed = true
                } else if (code != Yamux.GO_AWAY_NORMAL) {
                    close(4000)
                }
            }

            override fun pong(value: Int) {
                if (value != awaitingPong) return
                awaitingPong = null
                pongTask?.cancel(false)
                pongTask = null
            }
        })
        ready.complete(Unit)
        pingTask = scheduler.scheduleAtFixedRate(
            { ping() },
            pingIntervalMs,
            pingIntervalMs,
            TimeUnit.MILLISECONDS,
        )
    }

    @Synchronized
    private fun sendFrame(frame: Yamux.Frame) {
        if (state != State.OPEN) return
        val current = keys ?: return
        val record = try {
            current.send.seal(Yamux.encodeFrame(frame))
        } catch (_: NoiseException) {
            close(1000)
            return
        }
        try {
            transport.send(record)
        } catch (_: Exception) {
            close(1006)
            return
        }
        if (current.send.nonce >= Noise.NONCE_LIMIT - 1024) close(1000)
    }

    private fun ping() {
        val current = synchronized(this) {
            if (state == State.OPEN) mux else null
        } ?: return
        if (awaitingPong != null) return
        pingCounter = (pingCounter + 1) and 0x7fffffff
        awaitingPong = pingCounter
        try {
            current.ping(pingCounter)
        } catch (_: Exception) {
            close(1001)
            return
        }
        pongTask = scheduler.schedule({ close(1001) }, pingTimeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun end(code: Int) {
        synchronized(this) {
            if (state == State.CLOSED) return
            state = State.CLOSED
            deadline?.cancel(false)
            pingTask?.cancel(false)
            pongTask?.cancel(false)
            deadline = null
            pingTask = null
            pongTask = null
            awaitingPong = null
            mux?.closeAll()
            mux = null
            keys = null
            hello = null
            streams.clear()
        }
        synchronized(gate) { gate.notifyAll() }
        val error = SessionClosed(code)
        ready.completeExceptionally(error)
        closed.complete(code)
        onClosed?.invoke(code)
    }
}
