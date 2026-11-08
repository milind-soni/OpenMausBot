package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject
import org.openmausbot.android.e2e.E2EDescriptor
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String, val body: String? = null) : IOException(message)

/** A phone speaks to the companion sidecar, never to the harness directly.
 *  The device token rides on every request; SSE resumes from Last-Event-ID. */
class ApiClient(
    baseUrl: String,
    private val token: String?,
    private val loopbackHeaderName: String? = null,
    private val loopbackHeaderValue: String? = null,
) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val deviceName = android.os.Build.MODEL ?: "Android"

    fun get(path: String): JSONObject = JSONObject(request("GET", path, null) ?: "{}")

    fun getArray(path: String): JSONArray = JSONArray(request("GET", path, null) ?: "[]")

    fun post(path: String, body: JSONObject = JSONObject()): JSONObject =
        JSONObject(request("POST", path, body.toString()) ?: "{}")

    fun patch(path: String, body: JSONObject): JSONObject =
        JSONObject(request("PATCH", path, body.toString()) ?: "{}")

    fun put(path: String, body: JSONObject): JSONObject =
        JSONObject(request("PUT", path, body.toString()) ?: "{}")

    fun delete(path: String): JSONObject = JSONObject(request("DELETE", path, null) ?: "{}")

    /** Raw bytes for an attachment, image or export. */
    fun bytes(path: String): ByteArray {
        val connection = open("GET", path)
        connection.setRequestProperty("Accept", "*/*")
        return try {
            val status = connection.responseCode
            if (status !in 200..299) throw ApiException(status, readError(connection))
            connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    /** Multipart image upload; the harness accepts image-only attachments and
     *  stores them under a generated filename. */
    fun uploadImage(bytes: ByteArray, mime: String, filename: String): JSONObject {
        val boundary = "omb-" + java.util.UUID.randomUUID().toString().replace("-", "")
        val connection = open("POST", "/api/attachments")
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        connection.doOutput = true
        val body = ByteArrayOutputStream().apply {
            val head = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$filename\"\r\n" +
                "Content-Type: $mime\r\n\r\n"
            write(head.toByteArray())
            write(bytes)
            write("\r\n--$boundary--\r\n".toByteArray())
        }.toByteArray()
        return try {
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) throw ApiException(status, JSONObject(text).optString("error", "上传失败"), text)
            JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    /** Redeems a pairing credential. Returns the long-lived device token. */
    fun pair(credential: String, serverNameHint: String?): PairResult {
        val body = JSONObject().apply {
            put("credential", credential)
            put("deviceName", deviceName)
        }
        val answer = post("/api/pair", body)
        val deviceToken = answer.optString("token").takeIf { it.isNotBlank() }
            ?: throw ApiException(401, "电脑没有返回设备令牌")
        val device = answer.optJSONObject("device")
        val endpoints = answer.optJSONArray("endpoints")?.let { array ->
            (0 until array.length()).mapNotNull { index ->
                when (val item = array.opt(index)) {
                    is String -> item.takeIf { it.isNotBlank() }
                    is JSONObject -> item.optString("url").takeIf { it.isNotBlank() }
                    else -> null
                }
            }
        } ?: emptyList()
        return PairResult(
            token = deviceToken,
            deviceId = device?.optString("id")?.takeIf { it.isNotBlank() } ?: (serverNameHint ?: baseUrl),
            serverName = answer.optString("serverName").takeIf { it.isNotBlank() }
                ?: serverNameHint ?: PairingInvite.hostOf(baseUrl),
            endpoints = endpoints,
            e2e = E2EDescriptor.from(answer.opt("e2e")),
        )
    }

    fun health(): JSONObject = JSONObject(request("GET", "/api/health", null) ?: "{}")

    /** Shared by ordinary requests and the SSE stream. The loopback header is
     *  the proxy's only admission check; Connection: close keeps one HTTP head
     *  per yamux stream. */
    internal fun applyHeaders(connection: HttpURLConnection) {
        connection.setRequestProperty("User-Agent", "OpenMausBot-Android/1.0")
        token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
        val name = loopbackHeaderName
        val value = loopbackHeaderValue
        if (name != null && value != null) {
            connection.setRequestProperty(name, value)
            connection.setRequestProperty("Connection", "close")
        }
    }

    private fun open(method: String, path: String): HttpURLConnection {
        val url = URL(baseUrl + path)
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = TimeUnit.SECONDS.toMillis(12).toInt()
        connection.readTimeout = TimeUnit.SECONDS.toMillis(30).toInt()
        connection.setRequestProperty("Accept", "application/json")
        applyHeaders(connection)
        return connection
    }

    private fun request(method: String, path: String, body: String?): String? {
        val connection = open(method, path)
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.toByteArray().size)
            connection.outputStream.use { it.write(body.toByteArray()) }
        }
        return try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }
            if (status !in 200..299) throw ApiException(status, errorText(text), text)
            text
        } finally {
            connection.disconnect()
        }
    }

    private fun readError(connection: HttpURLConnection): String =
        errorText(connection.errorStream?.bufferedReader()?.use { it.readText() })

    private fun errorText(text: String?): String {
        if (text.isNullOrBlank()) return "请求失败"
        return runCatching { JSONObject(text).optString("error", text) }.getOrDefault(text)
    }

    data class PairResult(
        val token: String,
        val deviceId: String,
        val serverName: String,
        val endpoints: List<String>,
        val e2e: E2EDescriptor? = null,
    )

    /** Server-sent events. `onFrame` receives each JSON payload; `onCursor`
     *  gets the `id:` line so a reconnect resumes exactly where it stopped. */
    class Stream(
        private val client: ApiClient,
        private val lastEventId: String?,
    ) {
        @Volatile private var connection: HttpURLConnection? = null
        @Volatile var closed = false
            private set

        fun close() {
            closed = true
            connection?.disconnect()
        }

        fun run(
            onFrame: (JSONObject) -> Unit,
            onCursor: (String) -> Unit,
            onOpen: () -> Unit,
        ) {
            var attempt = 0
            while (!closed) {
                try {
                    attempt = 0
                    openOnce(onFrame, onCursor, onOpen)
                    if (closed) return
                } catch (e: IOException) {
                    if (closed) return
                    attempt++
                    // 1s, 2s, 4s, 8s, capped at 15s, with jitter so a fleet of
                    // phones does not reconnect in lockstep after a network blip.
                    val delay = (minOf(15_000L, 1_000L shl minOf(attempt, 4)) + (0..700L).random())
                    try {
                        Thread.sleep(delay)
                    } catch (interrupted: InterruptedException) {
                        return
                    }
                } catch (e: Exception) {
                    if (closed) return
                    try {
                        Thread.sleep(3_000)
                    } catch (interrupted: InterruptedException) {
                        return
                    }
                }
            }
        }

        private fun openOnce(
            onFrame: (JSONObject) -> Unit,
            onCursor: (String) -> Unit,
            onOpen: () -> Unit,
        ) {
            val url = URL(client.baseUrl + "/api/events")
            val conn = url.openConnection() as HttpURLConnection
            connection = conn
            conn.requestMethod = "GET"
            conn.connectTimeout = 15_000
            // No read timeout: an idle SSE stream is healthy and must not be
            // torn down and re-established every half minute.
            conn.readTimeout = 0
            conn.setRequestProperty("Accept", "text/event-stream")
            conn.setRequestProperty("Cache-Control", "no-cache")
            client.applyHeaders(conn)
            lastEventId?.let { conn.setRequestProperty("Last-Event-ID", it) }
            val status = conn.responseCode
            if (status !in 200..299) {
                val text = conn.errorStream?.bufferedReader()?.use { it.readText() }
                throw ApiException(status, text ?: "事件流被拒绝")
            }
            onOpen()
            BufferedInputStream(conn.inputStream).bufferedReader().use { reader ->
                val data = StringBuilder()
                var eventId: String? = null
                while (!closed) {
                    val line = reader.readLine() ?: break
                    when {
                        line.isEmpty() -> {
                            if (data.isNotEmpty()) {
                                val payload = runCatching { JSONObject(data.toString()) }.getOrNull()
                                data.setLength(0)
                                if (payload != null) onFrame(payload)
                                eventId?.let(onCursor)
                                eventId = null
                            }
                        }
                        line.startsWith("data:") -> {
                            val chunk = line.removePrefix("data:").trimStart()
                            if (data.isNotEmpty()) data.append('\n')
                            data.append(chunk)
                        }
                        line.startsWith("id:") -> eventId = line.removePrefix("id:").trim()
                        line.startsWith(":") -> Unit
                    }
                }
            }
            connection = null
        }
    }

    fun stream(): Stream = Stream(this, null)
    fun stream(lastEventId: String?): Stream = Stream(this, lastEventId)
}
