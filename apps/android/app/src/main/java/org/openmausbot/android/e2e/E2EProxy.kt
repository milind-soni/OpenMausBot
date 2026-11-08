package org.openmausbot.android.e2e

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue

/** A loopback HTTP endpoint backed by one yamux stream per accepted socket.
 *  `ApiClient` keeps speaking ordinary HTTP/1.1; only the base URL and one
 *  per-session header change. */
class E2EProxy(private val session: PhoneSession) : Closeable {
    val headerName: String = "X-OMB-Loopback"
    val headerValue: String = B64u.encode(Crypto.randomBytes(32))

    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val baseUrl: String = "http://127.0.0.1:${server.localPort}"
    private val sockets: MutableSet<Socket> =
        Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    @Volatile private var closed = false

    init {
        session.onClosed = { close() }
        Thread(::acceptLoop, "omb-e2e-proxy").apply {
            isDaemon = true
            start()
        }
    }

    private fun acceptLoop() {
        while (!closed) {
            val socket = try {
                server.accept()
            } catch (_: Exception) {
                if (closed) return
                continue
            }
            sockets.add(socket)
            Thread({ handle(socket) }, "omb-e2e-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun handle(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = 2_000
            val input = BufferedInputStream(socket.getInputStream())
            val head = readHead(input) ?: return
            if (!authorized(head)) return
            socket.soTimeout = 0

            val queue = LinkedBlockingQueue<Chunk>()
            val streamId = try {
                session.openStream(object : StreamSink {
                    override fun onData(data: ByteArray) {
                        queue.put(Chunk.Data(data))
                    }

                    override fun onEnd() {
                        queue.put(Chunk.End)
                    }

                    override fun onReset() {
                        queue.put(Chunk.Reset)
                        closeQuietly(socket)
                    }
                })
            } catch (_: Exception) {
                return
            }

            val output = BufferedOutputStream(socket.getOutputStream())
            Thread({ writeLoop(socket, output, queue, streamId) }, "omb-e2e-writer").apply {
                isDaemon = true
                start()
            }

            if (!session.writeAll(streamId, rewriteHost(head))) return
            val buffer = ByteArray(16 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) {
                    session.finish(streamId)
                    return
                }
                if (count == 0) continue
                if (!session.writeAll(streamId, buffer.copyOf(count))) return
            }
        } catch (_: Exception) {
        } finally {
            if (closed) closeQuietly(socket)
        }
    }

    private fun writeLoop(
        socket: Socket,
        output: BufferedOutputStream,
        queue: LinkedBlockingQueue<Chunk>,
        streamId: Int,
    ) {
        try {
            while (true) {
                when (val chunk = queue.take()) {
                    Chunk.End -> {
                        output.flush()
                        socket.shutdownOutput()
                        return
                    }
                    Chunk.Reset -> return
                    is Chunk.Data -> {
                        output.write(chunk.bytes)
                        output.flush()
                        session.consumed(streamId, chunk.bytes.size)
                    }
                }
            }
        } catch (_: Exception) {
        } finally {
            closeQuietly(socket)
            sockets.remove(socket)
        }
    }

    /** The first request head only. The caller sends it as the first stream
     *  bytes; everything after it is opaque. */
    private fun readHead(input: BufferedInputStream): ByteArray? {
        val out = ByteArrayOutputStream(1024)
        var state = 0
        while (out.size() < MAX_HEAD) {
            val value = input.read()
            if (value < 0) return null
            out.write(value)
            state = when {
                value == '\r'.code && state == 0 -> 1
                value == '\n'.code && state == 1 -> 2
                value == '\r'.code && state == 2 -> 3
                value == '\n'.code && state == 3 -> return out.toByteArray()
                else -> 0
            }
        }
        return null
    }

    private fun authorized(head: ByteArray): Boolean {
        val text = String(head, Charsets.ISO_8859_1)
        return text.lineSequence().any { line ->
            val colon = line.indexOf(':')
            colon > 0 &&
                line.substring(0, colon).trim().equals(headerName, ignoreCase = true) &&
                line.substring(colon + 1).trim() == headerValue
        }
    }

    private fun rewriteHost(head: ByteArray): ByteArray {
        val text = String(head, Charsets.ISO_8859_1)
        val changed = Regex("(?im)^Host:[^\r\n]*").replaceFirst(text, "Host: companion")
        return changed.toByteArray(Charsets.ISO_8859_1)
    }

    override fun close() {
        if (closed) return
        closed = true
        closeQuietly(server)
        for (socket in sockets.toList()) closeQuietly(socket)
        sockets.clear()
    }

    private fun closeQuietly(closeable: Closeable) {
        try {
            closeable.close()
        } catch (_: Exception) {
        }
    }

    private sealed class Chunk {
        data class Data(val bytes: ByteArray) : Chunk()
        object End : Chunk()
        object Reset : Chunk()
    }

    private companion object {
        const val MAX_HEAD = 16 * 1024
    }
}
