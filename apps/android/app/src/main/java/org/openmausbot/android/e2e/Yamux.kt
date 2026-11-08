package org.openmausbot.android.e2e

import java.nio.ByteBuffer
import java.nio.ByteOrder

class YamuxException(val reason: String) : Exception("yamux: $reason")

/** The profile inside the encrypted records: one frame per record, phone-opened
 *  streams only, 2 MiB windows. This module does no I/O. */
object Yamux {
    const val VERSION = 0
    const val TYPE_DATA = 0
    const val TYPE_WINDOW_UPDATE = 1
    const val TYPE_PING = 2
    const val TYPE_GO_AWAY = 3

    const val FLAG_SYN = 0x1
    const val FLAG_ACK = 0x2
    const val FLAG_FIN = 0x4
    const val FLAG_RST = 0x8
    private const val KNOWN_FLAGS = 0xf

    const val GO_AWAY_NORMAL = 0
    const val GO_AWAY_PROTOCOL = 1
    const val GO_AWAY_INTERNAL = 2
    const val GO_AWAY_REMOVED = 3

    const val HEADER_BYTES = 12
    const val MAX_DATA_PAYLOAD = 65_507
    const val INITIAL_WINDOW = 256 * 1024
    const val STREAM_WINDOW = 2 * 1024 * 1024
    const val OPEN_WINDOW_DELTA = STREAM_WINDOW - INITIAL_WINDOW
    const val WINDOW_UPDATE_AFTER = 1024 * 1024
    const val MAX_STREAMS = 64
    const val MAX_STREAM_ID = Int.MAX_VALUE
    const val PING_INTERVAL_MS = 20_000L
    const val PING_TIMEOUT_MS = 10_000L

    data class Frame(
        val type: Int,
        val flags: Int,
        val streamId: Int,
        val length: Int,
        val data: ByteArray? = null,
    )

    fun encodeFrame(frame: Frame): ByteArray {
        val payload = if (frame.type == TYPE_DATA) frame.data ?: ByteArray(0) else ByteArray(0)
        if (frame.type == TYPE_DATA && payload.size != frame.length) throw YamuxException("data_length")
        if (payload.size > MAX_DATA_PAYLOAD) throw YamuxException("data_too_large")
        val out = ByteBuffer.allocate(HEADER_BYTES + payload.size).order(ByteOrder.BIG_ENDIAN)
        out.put(VERSION.toByte())
        out.put(frame.type.toByte())
        out.putShort(frame.flags.toShort())
        out.putInt(frame.streamId)
        out.putInt(frame.length)
        out.put(payload)
        return out.array()
    }

    fun decodeFrame(bytes: ByteArray): Frame {
        if (bytes.size < HEADER_BYTES) throw YamuxException("short_frame")
        val view = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        if (view.get().toInt() and 0xff != VERSION) throw YamuxException("version")
        val type = view.get().toInt() and 0xff
        if (type > TYPE_GO_AWAY) throw YamuxException("type")
        val flags = view.short.toInt() and 0xffff
        if ((flags and KNOWN_FLAGS.inv()) != 0) throw YamuxException("flags")
        val streamId = view.int
        val length = view.int
        if (type == TYPE_DATA) {
            if (length > MAX_DATA_PAYLOAD) throw YamuxException("data_too_large")
            if (bytes.size != HEADER_BYTES + length) throw YamuxException("data_length")
            if (streamId == 0) throw YamuxException("stream_zero")
            return Frame(type, flags, streamId, length, bytes.copyOfRange(HEADER_BYTES, bytes.size))
        }
        if (bytes.size != HEADER_BYTES) throw YamuxException("trailing_bytes")
        if (type == TYPE_WINDOW_UPDATE) {
            if (streamId == 0) throw YamuxException("stream_zero")
        } else {
            if (streamId != 0) throw YamuxException("session_frame_stream")
            if (type == TYPE_PING && flags != FLAG_SYN && flags != FLAG_ACK) throw YamuxException("ping_flags")
            if (type == TYPE_GO_AWAY && flags != 0) throw YamuxException("goaway_flags")
        }
        return Frame(type, flags, streamId, length)
    }

    fun openFrame(streamId: Int): Frame = Frame(TYPE_WINDOW_UPDATE, FLAG_SYN, streamId, OPEN_WINDOW_DELTA)
    fun acceptFrame(streamId: Int): Frame = Frame(TYPE_WINDOW_UPDATE, FLAG_ACK, streamId, OPEN_WINDOW_DELTA)
    fun resetFrame(streamId: Int): Frame = Frame(TYPE_WINDOW_UPDATE, FLAG_RST, streamId, 0)
    fun finFrame(streamId: Int): Frame = Frame(TYPE_WINDOW_UPDATE, FLAG_FIN, streamId, 0)
    fun windowFrame(streamId: Int, delta: Int): Frame = Frame(TYPE_WINDOW_UPDATE, 0, streamId, delta)
    fun dataFrame(streamId: Int, data: ByteArray, flags: Int = 0): Frame =
        Frame(TYPE_DATA, flags, streamId, data.size, data)
    fun pingFrame(value: Int, flags: Int = FLAG_SYN): Frame = Frame(TYPE_PING, flags, 0, value)
    fun goAwayFrame(code: Int): Frame = Frame(TYPE_GO_AWAY, 0, 0, code)

    interface MuxEvents {
        fun send(frame: Frame)
        fun opened(streamId: Int) {}
        fun accepted(streamId: Int) {}
        fun data(streamId: Int, data: ByteArray)
        fun ended(streamId: Int)
        fun reset(streamId: Int)
        fun writable(streamId: Int) {}
        fun goAway(code: Int) {}
        fun pong(value: Int) {}
    }

    private data class StreamState(
        var established: Boolean,
        var receiveWindow: Int,
        var sendWindow: Int,
        var uncredited: Int,
        var localFin: Boolean,
        var remoteFin: Boolean,
    )

    class Mux(
        val role: String,
        private val events: MuxEvents,
    ) {
        private val streams = HashMap<Int, StreamState>()
        private var highestId = 0
        private var peerGoneAway = false
        private var localGoneAway = false

        val activeStreams: Int get() = streams.size
        val peerGone: Boolean get() = peerGoneAway

        fun has(streamId: Int): Boolean = streams.containsKey(streamId)
        fun sendWindow(streamId: Int): Int = streams[streamId]?.sendWindow ?: 0

        /** The phone side. Data may follow at once, within the first 256 KiB. */
        fun open(): Int {
            if (role != "phone") throw YamuxException("computer_open")
            if (localGoneAway || peerGoneAway) throw YamuxException("gone_away")
            if (streams.size >= MAX_STREAMS) throw YamuxException("too_many_streams")
            val streamId = if (highestId == 0) 1 else highestId + 2
            if (streamId > MAX_STREAM_ID) throw YamuxException("ids_exhausted")
            highestId = streamId
            streams[streamId] = StreamState(
                established = false,
                receiveWindow = INITIAL_WINDOW + OPEN_WINDOW_DELTA,
                sendWindow = INITIAL_WINDOW,
                uncredited = 0,
                localFin = false,
                remoteFin = false,
            )
            events.send(openFrame(streamId))
            return streamId
        }

        /** The computer side, once the origin socket is connected. */
        fun accept(streamId: Int) {
            val stream = streams[streamId] ?: return
            if (stream.established || role != "computer") return
            stream.established = true
            stream.receiveWindow += OPEN_WINDOW_DELTA
            events.send(acceptFrame(streamId))
        }

        /** Sends up to the window and the frame cap; returns the bytes taken. */
        fun write(streamId: Int, data: ByteArray): Int {
            val stream = streams[streamId] ?: return 0
            if (stream.localFin || (role == "computer" && !stream.established)) return 0
            val size = minOf(data.size, stream.sendWindow, MAX_DATA_PAYLOAD)
            if (size <= 0) return 0
            stream.sendWindow -= size
            events.send(dataFrame(streamId, data.copyOfRange(0, size)))
            return size
        }

        fun finish(streamId: Int) {
            val stream = streams[streamId] ?: return
            if (stream.localFin) return
            stream.localFin = true
            events.send(finFrame(streamId))
            closeIfDone(streamId, stream)
        }

        fun reset(streamId: Int) {
            if (streams.remove(streamId) == null) return
            events.send(resetFrame(streamId))
            events.reset(streamId)
        }

        /** The receiver handed `bytes` on; grants them back in 1 MiB steps. */
        fun consumed(streamId: Int, bytes: Int) {
            val stream = streams[streamId] ?: return
            if (stream.remoteFin) return
            stream.uncredited += bytes
            if (stream.uncredited < WINDOW_UPDATE_AFTER) return
            val delta = stream.uncredited
            stream.uncredited = 0
            stream.receiveWindow += delta
            events.send(windowFrame(streamId, delta))
        }

        fun ping(value: Int) = events.send(pingFrame(value))

        fun goAway(code: Int = GO_AWAY_NORMAL) {
            localGoneAway = true
            events.send(goAwayFrame(code))
        }

        fun protocolError() {
            goAway(GO_AWAY_PROTOCOL)
            closeAll()
        }

        fun closeAll() {
            val ids = streams.keys.toList()
            streams.clear()
            for (id in ids) events.reset(id)
        }

        fun receive(frame: Frame) {
            if (frame.type == TYPE_PING) {
                if (frame.flags == FLAG_SYN) events.send(pingFrame(frame.length, FLAG_ACK))
                else events.pong(frame.length)
                return
            }
            if (frame.type == TYPE_GO_AWAY) {
                peerGoneAway = true
                events.goAway(frame.length)
                return
            }
            if (frame.flags and FLAG_SYN != 0) {
                receiveOpen(frame)
                return
            }
            if (frame.flags and FLAG_ACK != 0) {
                receiveAck(frame)
                return
            }
            val stream = known(frame.streamId) ?: return
            receiveOnStream(frame.streamId, stream, frame)
        }

        private fun known(streamId: Int): StreamState? {
            if (streamId % 2 == 0 || streamId > highestId) throw YamuxException("unknown_stream")
            return streams[streamId]
        }

        private fun receiveOpen(frame: Frame) {
            if (role == "phone") throw YamuxException("computer_opened_stream")
            if (frame.type != TYPE_WINDOW_UPDATE || frame.flags != FLAG_SYN) throw YamuxException("open_flags")
            if (frame.streamId % 2 == 0) throw YamuxException("even_stream")
            if (frame.streamId <= highestId) throw YamuxException("stream_reused")
            highestId = frame.streamId
            if (localGoneAway || streams.size >= MAX_STREAMS) {
                events.send(resetFrame(frame.streamId))
                return
            }
            streams[frame.streamId] = StreamState(
                established = false,
                receiveWindow = INITIAL_WINDOW,
                sendWindow = INITIAL_WINDOW + frame.length,
                uncredited = 0,
                localFin = false,
                remoteFin = false,
            )
            events.opened(frame.streamId)
        }

        private fun receiveAck(frame: Frame) {
            if (role == "computer") throw YamuxException("phone_ack")
            if (frame.type != TYPE_WINDOW_UPDATE || (frame.flags and (FLAG_ACK or FLAG_FIN or FLAG_RST).inv()) != 0) {
                throw YamuxException("ack_flags")
            }
            val stream = known(frame.streamId) ?: return
            if (stream.established) throw YamuxException("duplicate_ack")
            stream.established = true
            events.accepted(frame.streamId)
            receiveOnStream(frame.streamId, stream, frame.copy(flags = frame.flags and FLAG_ACK.inv()))
        }

        private fun receiveOnStream(streamId: Int, stream: StreamState, frame: Frame) {
            if (frame.flags and FLAG_RST != 0) {
                streams.remove(streamId)
                events.reset(streamId)
                return
            }
            if (frame.type == TYPE_DATA) {
                if (stream.remoteFin && (frame.length > 0 || frame.flags and FLAG_FIN != 0)) {
                    throw YamuxException("data_after_fin")
                }
                if (frame.length > stream.receiveWindow) throw YamuxException("window_exceeded")
                stream.receiveWindow -= frame.length
                if (frame.length > 0) events.data(streamId, frame.data ?: ByteArray(0))
            } else if (frame.length > 0) {
                stream.sendWindow += frame.length
                events.writable(streamId)
            }
            if (frame.flags and FLAG_FIN != 0) {
                if (stream.remoteFin) throw YamuxException("data_after_fin")
                stream.remoteFin = true
                events.ended(streamId)
                closeIfDone(streamId, stream)
            }
        }

        private fun closeIfDone(streamId: Int, stream: StreamState) {
            if (stream.localFin && stream.remoteFin) streams.remove(streamId)
        }
    }
}
