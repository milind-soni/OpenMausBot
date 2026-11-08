package org.openmausbot.android.e2e

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** A live encrypted session and the loopback HTTP endpoint over it. */
class E2EConnection(
    val session: PhoneSession,
    val proxy: E2EProxy,
) : Closeable {
    val baseUrl: String get() = proxy.baseUrl
    val headerName: String get() = proxy.headerName
    val headerValue: String get() = proxy.headerValue

    override fun close() {
        proxy.close()
        session.shutdown()
    }
}

/** Dials direct Wi-Fi/Tailscale first, then the relay. A descriptor pins the
 *  computer's transport key, so a failed route is never silently replaced by
 *  a plain-HTTP one. */
class E2EClient(
    private val descriptor: E2EDescriptor,
    private val credential: String,
    origins: List<String>,
    private val app: String = "OpenMausBot Android",
    private val timeoutMs: Long = 12_000L,
) {
    private val origins = origins.filter { it.isNotBlank() }.distinct()
    private val http = sharedHttp
    private val psk: ByteArray = pskFor(credential, descriptor)
    private val admission: ByteArray? = descriptor.hostId?.let { admissionFor(credential, it) }

    fun connect(): E2EConnection {
        var last: Throwable? = null
        for (url in origins.mapNotNull(::directUrl).distinct()) {
            try {
                return wrap(dial(url, direct = true))
            } catch (error: Throwable) {
                last = error
            }
        }
        val hostId = descriptor.hostId
        val adm = admission
        if (hostId == null || adm == null) throw IOException("端到端直连失败", last)
        for (node in descriptor.relays) {
            try {
                return wrap(dial("wss://$node/v1/phone", direct = false))
            } catch (error: Throwable) {
                last = error
            }
        }
        throw IOException("无法连接这台电脑", last)
    }

    private fun wrap(session: PhoneSession): E2EConnection {
        return try {
            E2EConnection(session, E2EProxy(session))
        } catch (error: Throwable) {
            session.close(1000)
            throw error
        }
    }

    private fun dial(url: String, direct: Boolean): PhoneSession {
        val sessionRef = AtomicReference<PhoneSession>()
        val failure = AtomicReference<Throwable>()
        val created = CountDownLatch(1)
        val protocol = if (direct) DIRECT_PROTOCOL else RELAY_PROTOCOL

        fun fail(error: Throwable) {
            failure.compareAndSet(null, error)
            created.countDown()
        }

        fun start(socket: WebSocket) {
            try {
                val session = PhoneSession(
                    transport = OkHttpRecordTransport(socket),
                    transportByte = if (direct) Noise.TRANSPORT_DIRECT else Noise.TRANSPORT_RELAY,
                    remoteStatic = descriptor.key,
                    psk = psk,
                    app = app,
                )
                if (!sessionRef.compareAndSet(null, session)) {
                    session.close(1000)
                    return
                }
                created.countDown()
            } catch (error: Throwable) {
                fail(error)
                socket.close(4000, "init")
            }
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (direct) {
                    start(webSocket)
                    return
                }
                val hostId = descriptor.hostId
                val adm = admission
                if (hostId == null || adm == null) {
                    fail(IOException("relay descriptor missing host"))
                    webSocket.close(4400, "")
                    return
                }
                val greeting = JSONObject()
                    .put("t", "phone")
                    .put("v", 1)
                    .put("hid", B64u.encode(hostId))
                    .put("adm", B64u.encode(adm))
                    .toString()
                webSocket.send(greeting)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val session = sessionRef.get()
                if (session != null) {
                    session.receive(text.toByteArray(Charsets.UTF_8), false)
                    return
                }
                if (direct) {
                    fail(SessionClosed(4000))
                    webSocket.close(4000, "")
                    return
                }
                val ready = runCatching { JSONObject(text).optString("t") == "ready" }
                    .getOrDefault(false)
                if (!ready) {
                    fail(SessionClosed(4400))
                    webSocket.close(4400, "")
                    return
                }
                start(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val session = sessionRef.get()
                if (session == null) {
                    fail(SessionClosed(if (direct) 4000 else 4400))
                    webSocket.close(4000, "")
                    return
                }
                session.receive(bytes.toByteArray(), true)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                val session = sessionRef.get()
                if (session != null) session.transportClosed(code) else fail(SessionClosed(code))
                webSocket.close(1000, "")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                val session = sessionRef.get()
                if (session != null) session.transportClosed(code) else fail(SessionClosed(code))
                created.countDown()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sessionRef.get()?.transportClosed(1006)
                fail(t)
                created.countDown()
            }
        }

        val socket = http.newWebSocket(
            Request.Builder()
                .url(url)
                .header("Sec-WebSocket-Protocol", protocol)
                .build(),
            listener,
        )
        try {
            val waitMs = timeoutMs + if (direct) 0 else 10_000L
            if (!created.await(waitMs, TimeUnit.MILLISECONDS)) fail(SessionClosed(4002))
            failure.get()?.let {
                sessionRef.get()?.close(4002)
                socket.cancel()
                throw it
            }
            val session = sessionRef.get() ?: run {
                socket.cancel()
                throw SessionClosed(4002)
            }
            try {
                session.awaitReady(timeoutMs)
            } catch (error: Throwable) {
                session.close(4002)
                socket.cancel()
                throw error
            }
            return session
        } catch (error: Throwable) {
            sessionRef.get()?.close(4002)
            socket.cancel()
            throw error
        }
    }

    private fun directUrl(origin: String): String? {
        val uri = runCatching { URI(origin) }.getOrNull() ?: return null
        val scheme = when (uri.scheme?.lowercase()) {
            "http" -> "ws"
            "https" -> "wss"
            else -> return null
        }
        val host = uri.host ?: return null
        val port = if (uri.port > 0) uri.port else if (scheme == "wss") 443 else 80
        return "$scheme://$host:$port/v1/e2e"
    }

    private companion object {
        const val DIRECT_PROTOCOL = "omb-e2e.v1"
        const val RELAY_PROTOCOL = "omb-relay.v1"

        /** One pool for every reconnect; a per-dial client would leak its
         *  dispatcher and idle connections. */
        val sharedHttp: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(6, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build()
        }

        fun pskFor(credential: String, descriptor: E2EDescriptor): ByteArray {
            val credentialHash = Crypto.sha256(credential.toByteArray(Charsets.UTF_8))
            val keyId = Crypto.sha256(descriptor.key).copyOfRange(0, 16)
            return Crypto.hmacSha256(
                credentialHash,
                "omb-e2e psk v1".toByteArray(Charsets.UTF_8) + keyId,
            )
        }

        fun admissionFor(credential: String, hostId: ByteArray): ByteArray {
            val credentialHash = Crypto.sha256(credential.toByteArray(Charsets.UTF_8))
            return Crypto.hmacSha256(
                credentialHash,
                "omb-relay admission v1".toByteArray(Charsets.UTF_8) + hostId,
            )
        }
    }
}
