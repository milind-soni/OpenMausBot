package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject
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
    private val connectTimeoutMs: Int = TimeUnit.SECONDS.toMillis(12).toInt(),
    private val readTimeoutMs: Int = TimeUnit.SECONDS.toMillis(30).toInt(),
) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val deviceName: String =
        runCatching { android.os.Build.MODEL }.getOrNull()?.takeIf { it.isNotBlank() } ?: "Android"

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

    /** Redeems a one-time pairing credential for a device token. The only
     *  call made without a device token. New QR credentials use the explicit
     *  `credential` field; a six-digit legacy code keeps its `code` field. */
    fun pair(
        credential: String,
        serverNameHint: String?,
        pairRequestId: String? = null,
    ): PairResult {
        val body = JSONObject().apply {
            put(if (credential.length == 6 && credential.all(Char::isDigit)) "code" else "credential", credential)
            put("deviceName", deviceName)
            pairRequestId?.let { put("pairRequestId", it) }
        }
        val answer = post("/api/pair", body)
        val deviceToken = answer.optString("token").takeIf { it.isNotBlank() }
            ?: throw ApiException(401, "电脑没有返回设备令牌")
        val device = answer.optJSONObject("device")
        val endpoints = parseEndpoints(answer.optJSONArray("endpoints"))
        val hosts = answer.optJSONArray("hosts")?.let { array ->
            (0 until array.length()).mapNotNull { index ->
                array.optString(index).takeIf { it.isNotBlank() }
            }
        } ?: emptyList()
        return PairResult(
            token = deviceToken,
            deviceId = device?.optString("id")?.takeIf { it.isNotBlank() } ?: (serverNameHint ?: baseUrl),
            serverName = answer.optString("serverName").takeIf { it.isNotBlank() }
                ?: serverNameHint ?: PairingInvite.hostOf(baseUrl),
            hosts = hosts,
            endpoints = endpoints,
        )
    }

    fun health(): JSONObject = JSONObject(request("GET", "/api/health", null) ?: "{}")

    /** The sidecar-owned route snapshot. It contains no account or pairing
     *  credential and is how a paired phone learns about a new hosted URL. */
    fun connectionMetadata(): ConnectionMetadata {
        val answer = get("/api/companion/endpoints")
        return ConnectionMetadata(
            serverName = answer.optString("serverName"),
            hosts = answer.optJSONArray("hosts")?.let { array ->
                (0 until array.length()).mapNotNull { index ->
                    array.optString(index).takeIf { it.isNotBlank() }
                }
            },
            endpoints = parseEndpoints(answer.optJSONArray("endpoints")),
        )
    }

    private fun parseEndpoints(array: JSONArray?): List<CompanionEndpoint> {
        array ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            when (val item = array.opt(index)) {
                is JSONObject -> CompanionEndpoint.fromJson(item)
                is String -> item.takeIf { it.isNotBlank() }?.let { url ->
                    CompanionEndpoint.create(url, CompanionEndpoint.kindForOrigin(url), index)
                }
                else -> null
            }
        }.distinctBy { it.url }
    }

    private fun applyHeaders(connection: HttpURLConnection) {
        connection.setRequestProperty("User-Agent", "OpenMausBot-Android/1.0")
        token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    }

    private fun open(method: String, path: String): HttpURLConnection {
        val url = URL(baseUrl + path)
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
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
        val hosts: List<String> = emptyList(),
        val endpoints: List<CompanionEndpoint> = emptyList(),
    )

    /** One attempt at the event stream. Reconnection and route failover belong
     *  to the caller, which knows whether the app is on screen and which
     *  other routes are allowed. A stream that ends before `hello` throws
     *  `MissingStreamHelloException` so a captive page or proxy cannot look
     *  healthy forever. */
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
            var helloSeen = false
            var opened = false
            val conn = URL(client.baseUrl + "/api/events").openConnection() as HttpURLConnection
            connection = conn
            try {
                conn.requestMethod = "GET"
                conn.connectTimeout = 15_000
                // The sidecar sends a keepalive comment every 25 seconds, so
                // silence longer than this is a dead route, not an idle one.
                conn.readTimeout = 90_000
                conn.setRequestProperty("Accept", "text/event-stream")
                conn.setRequestProperty("Cache-Control", "no-cache")
                client.applyHeaders(conn)
                lastEventId?.let { conn.setRequestProperty("Last-Event-ID", it) }
                val status = conn.responseCode
                if (status !in 200..299) {
                    val text = conn.errorStream?.bufferedReader()?.use { it.readText() }
                    throw ApiException(status, text ?: "事件流被拒绝", text)
                }
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
                                    if (payload != null) {
                                        if (!helloSeen && payload.optString("kind") == "hello") {
                                            helloSeen = true
                                            opened = true
                                            onOpen()
                                        }
                                        onFrame(payload)
                                    }
                                    eventId?.let(onCursor)
                                    eventId = null
                                }
                            }
                            line.startsWith(":") -> Unit
                            line.startsWith("data:") -> {
                                val chunk = line.removePrefix("data:").let {
                                    if (it.startsWith(" ")) it.drop(1) else it
                                }
                                if (data.isNotEmpty()) data.append('\n')
                                data.append(chunk)
                            }
                            line.startsWith("id:") -> eventId = line.removePrefix("id:").trim()
                        }
                    }
                }
                if (!closed && !helloSeen && !opened) throw MissingStreamHelloException()
            } finally {
                connection = null
                conn.disconnect()
            }
        }
    }

    fun stream(): Stream = Stream(this, null)
    fun stream(lastEventId: String?): Stream = Stream(this, lastEventId)
}
