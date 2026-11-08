package org.openmausbot.android.e2e

import okhttp3.WebSocket
import okio.ByteString.Companion.toByteString

/** The only thing the session needs from a WebSocket. */
interface RecordTransport {
    fun send(message: ByteArray)
    fun close(code: Int, reason: String = "")
    val bufferedAmount: Long
    fun onceDrained(listener: () -> Unit)
}

const val SEND_BUFFER_HIGH = 1024 * 1024

class OkHttpRecordTransport(private val socket: WebSocket) : RecordTransport {
    override fun send(message: ByteArray) {
        socket.send(message.toByteString())
    }

    override fun close(code: Int, reason: String) {
        if (code == 1000 || code in 3000..4999) socket.close(code, reason) else socket.cancel()
    }

    override val bufferedAmount: Long get() = socket.queueSize()

    override fun onceDrained(listener: () -> Unit) {
        if (bufferedAmount <= SEND_BUFFER_HIGH / 4) {
            listener()
            return
        }
        Thread {
            while (bufferedAmount > SEND_BUFFER_HIGH / 4) {
                try {
                    Thread.sleep(20)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
            listener()
        }.apply {
            name = "omb-e2e-drain"
            isDaemon = true
            start()
        }
    }
}
