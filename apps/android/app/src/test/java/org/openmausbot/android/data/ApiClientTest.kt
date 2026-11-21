package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.Closeable
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class ApiClientTest {
    @Test
    fun pairingSendsTheLogicalRequestIdAndParsesTypedRoutes() {
        var captured: JSONObject? = null
        val server = TestHttpServer { request, out ->
            captured = JSONObject(String(request.body))
            val answer = JSONObject()
                .put("token", "omb_device")
                .put("device", JSONObject().put("id", "device-1"))
                .put("serverName", "Mac")
                .put("hosts", JSONArray().put("192.168.1.42"))
                .put(
                    "endpoints",
                    JSONArray().put(
                        JSONObject()
                            .put("url", "https://mac.companion.example")
                            .put("kind", "hosted")
                            .put("priority", 0)
                    )
                )
            out.respond("201 Created", "application/json", answer.toString())
        }
        try {
            val result = ApiClient(server.baseUrl, null, 4_000, 4_000)
                .pair("omb_pair_" + "a".repeat(43), "Android", "req-1")

            assertEquals("req-1", captured?.optString("pairRequestId"))
            assertEquals("omb_pair_" + "a".repeat(43), captured?.optString("credential"))
            assertEquals("device-1", result.deviceId)
            assertEquals("https://mac.companion.example", result.endpoints.single().url)
            assertEquals(listOf("192.168.1.42"), result.hosts)
        } finally {
            server.close()
        }
    }

    @Test
    fun aStreamThatSaysHelloOpensAndDeliversTheFrame() {
        val server = TestHttpServer { _, out ->
            out.respond(
                "200 OK",
                "text/event-stream",
                "id: 1\ndata: {\"kind\":\"hello\",\"cursor\":\"1\"}\n\n",
            )
        }
        try {
            val frames = mutableListOf<JSONObject>()
            var opened = 0
            ApiClient(server.baseUrl, null, 4_000, 4_000).stream(null).run(
                onFrame = { frames += it },
                onCursor = {},
                onOpen = { opened += 1 },
            )

            assertEquals(1, opened)
            assertEquals("hello", frames.single().optString("kind"))
        } finally {
            server.close()
        }
    }

    @Test
    fun aStreamThatEndsBeforeHelloIsNotAConnectedRoute() {
        val server = TestHttpServer { _, out ->
            out.respond("200 OK", "text/event-stream", ": keepalive\n\n")
        }
        try {
            ApiClient(server.baseUrl, null, 4_000, 4_000).stream(null).run(
                onFrame = {},
                onCursor = {},
                onOpen = {},
            )
            fail("a hello-less stream must fail the route")
        } catch (_: MissingStreamHelloException) {
        } finally {
            server.close()
        }
    }

    private data class Request(val method: String, val path: String, val body: ByteArray)

    private class TestHttpServer(
        private val handler: (Request, OutputStream) -> Unit,
    ) : Closeable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val baseUrl = "http://127.0.0.1:${server.localPort}"

        init {
            thread(isDaemon = true, name = "test-http") {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    thread(isDaemon = true) { serve(socket) }
                }
            }
        }

        private fun serve(socket: Socket) {
            socket.use { open ->
                val input = open.getInputStream().bufferedReader()
                val requestLine = input.readLine() ?: return
                val parts = requestLine.split(' ')
                if (parts.size < 2) return
                var contentLength = 0
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = line.substringAfter(':').trim().toIntOrNull() ?: 0
                    }
                }
                val body = if (contentLength > 0) {
                    val chars = CharArray(contentLength)
                    var offset = 0
                    while (offset < contentLength) {
                        val read = input.read(chars, offset, contentLength - offset)
                        if (read < 0) break
                        offset += read
                    }
                    String(chars, 0, offset).toByteArray()
                } else {
                    ByteArray(0)
                }
                handler(Request(parts[0], parts[1], body), open.getOutputStream())
            }
        }

        override fun close() {
            server.close()
        }
    }
}

private fun OutputStream.respond(status: String, contentType: String, body: String) {
    val bytes = body.toByteArray()
    write(
        (
            "HTTP/1.1 $status\r\nContent-Type: $contentType\r\n" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            ).toByteArray()
    )
    write(bytes)
    flush()
}
