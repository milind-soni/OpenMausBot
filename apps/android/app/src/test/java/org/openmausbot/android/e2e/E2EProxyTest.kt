package org.openmausbot.android.e2e

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Drives the phone's real session and loopback proxy against a small
 *  computer-side responder. No Android, no network and no relay. */
class E2EProxyTest {
    @Test
    fun healthRequestTravelsThroughEncryptedYamuxStream() {
        val computerKey = Crypto.generateKeyPair()
        val psk = ByteArray(32) { (it + 1).toByte() }
        val link = LoopLink(computerKey, psk)
        val phone = PhoneSession(
            transport = link,
            transportByte = Noise.TRANSPORT_DIRECT,
            remoteStatic = computerKey.publicKey,
            psk = psk,
            app = "test/1",
        )
        link.attach(phone)
        phone.ready.get(5, TimeUnit.SECONDS)

        val proxy = E2EProxy(phone)
        try {
            val url = URL(proxy.baseUrl + "/api/health")
            val connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 3_000
            connection.readTimeout = 3_000
            connection.setRequestProperty(proxy.headerName, proxy.headerValue)
            assertEquals(200, connection.responseCode)
            assertEquals("OK", connection.inputStream.bufferedReader().use { it.readText() })
            connection.disconnect()
        } finally {
            proxy.close()
            phone.shutdown()
            link.close(1000)
        }
    }
}

private class LoopLink(
    computerKey: Crypto.P256KeyPair,
    psk: ByteArray,
) : RecordTransport {
    private val outbound = LinkedBlockingQueue<ByteArray>()
    private val inbound = LinkedBlockingQueue<ByteArray>()
    private val computer = ComputerPeer(computerKey, psk) { inbound.put(it) }
    private lateinit var phone: PhoneSession
    @Volatile private var running = true
    private val pumpThread = Thread { pump() }.apply {
        name = "e2e-test-pump"
        isDaemon = true
        start()
    }

    fun attach(session: PhoneSession) {
        phone = session
    }

    override fun send(message: ByteArray) {
        outbound.put(message)
    }

    override fun close(code: Int, reason: String) {
        running = false
        pumpThread.interrupt()
    }

    override val bufferedAmount: Long get() = 0
    override fun onceDrained(listener: () -> Unit) = listener()

    private fun pump() {
        while (running) {
            val message = try {
                outbound.poll(5, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                return
            }
            if (message != null) {
                try {
                    computer.receive(message)
                } catch (_: Exception) {
                    return
                }
            }
            if (!::phone.isInitialized) continue
            val reply = try {
                inbound.poll(5, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                return
            }
            if (reply != null) {
                try {
                    phone.receive(reply, true)
                } catch (_: Exception) {
                    return
                }
            }
        }
    }
}

private class ComputerPeer(
    private val keyPair: Crypto.P256KeyPair,
    private val psk: ByteArray,
    private val sendToPhone: (ByteArray) -> Unit,
) {
    private var sendCipher: Noise.RecordCipher? = null
    private var receiveCipher: Noise.RecordCipher? = null
    private var mux: Yamux.Mux? = null
    private val request = ByteArrayOutputStream()
    private var responded = false
    private var pending: ByteArray? = null

    fun receive(message: ByteArray) {
        val cipher = receiveCipher
        if (cipher == null) {
            handshake(message)
            return
        }
        val plaintext = cipher.open(message)
        mux!!.receive(Yamux.decodeFrame(plaintext))
    }

    private fun handshake(message1: ByteArray) {
        val e = message1.copyOfRange(0, Noise.PUBLIC_KEY_BYTES)
        val state = Noise.SymmetricState.initialize()
        state.mixHash(Noise.prologue(Noise.TRANSPORT_DIRECT))
        state.mixHash(keyPair.publicKey)
        state.mixKeyAndHash(psk)
        state.mixHash(e)
        state.mixKey(e)
        state.mixKey(Crypto.dh(keyPair.privateKey, e)!!)
        val payload1 = state.decryptAndHash(
            message1.copyOfRange(Noise.PUBLIC_KEY_BYTES, message1.size)
        )
        val conn = Regex("\"conn\"\\s*:\\s*\"([A-Za-z0-9_-]+)\"")
            .find(String(payload1, Charsets.UTF_8))!!
            .groupValues[1]

        val e2 = Crypto.generateKeyPair()
        state.mixHash(e2.publicKey)
        state.mixKey(e2.publicKey)
        state.mixKey(Crypto.dh(e2.privateKey, e)!!)
        val message2 = e2.publicKey + state.encryptAndHash(Noise.encodePayload2(conn))
        sendToPhone(message2)

        val (pc, cp) = state.split()
        sendCipher = Noise.RecordCipher(pc)
        receiveCipher = Noise.RecordCipher(cp)
        mux = Yamux.Mux("computer", object : Yamux.MuxEvents {
            override fun send(frame: Yamux.Frame) {
                sendFrame(frame)
            }

            override fun opened(streamId: Int) {
                mux?.accept(streamId)
            }

            override fun data(streamId: Int, data: ByteArray) {
                request.write(data)
                if (responded) return
                if (!String(request.toByteArray(), Charsets.ISO_8859_1).contains("\r\n\r\n")) return
                responded = true
                val response = (
                    "HTTP/1.1 200 OK\r\n" +
                        "Content-Length: 2\r\n" +
                        "Content-Type: text/plain\r\n" +
                        "Connection: close\r\n\r\nOK"
                    ).toByteArray(Charsets.ISO_8859_1)
                writeAll(streamId, response)
            }

            override fun ended(streamId: Int) = Unit
            override fun reset(streamId: Int) = Unit

            override fun writable(streamId: Int) {
                pending?.let { writeAll(streamId, it) }
            }
        })
    }

    private fun writeAll(streamId: Int, data: ByteArray) {
        var offset = 0
        while (offset < data.size) {
            val taken = mux?.write(streamId, data.copyOfRange(offset, data.size)) ?: return
            if (taken == 0) {
                pending = data.copyOfRange(offset, data.size)
                return
            }
            offset += taken
        }
        pending = null
        mux?.finish(streamId)
    }

    private fun sendFrame(frame: Yamux.Frame) {
        val cipher = sendCipher ?: return
        sendToPhone(cipher.seal(Yamux.encodeFrame(frame)))
    }
}
