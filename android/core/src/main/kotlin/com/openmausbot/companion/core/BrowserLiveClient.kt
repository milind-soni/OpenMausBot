package com.openmausbot.companion.core

import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * What arrives on `GET /api/bots/:id/browser/live`.
 *
 * The server normalises every message before it reaches us
 * (`normalizeBrowserLiveMessage`), so these are the only shapes possible and
 * an unknown one is a protocol change, not untrusted input.
 */
sealed interface BrowserLiveMessage {
    data class Frame(val frame: BrowserFrame) : BrowserLiveMessage
    data class Status(val status: BrowserStatus) : BrowserLiveMessage
    data class Url(val url: String) : BrowserLiveMessage
    data class Tabs(val tabs: List<BrowserTab>) : BrowserLiveMessage
    data class Ready(val viewerId: String) : BrowserLiveMessage
    data class Control(val controlling: Boolean, val held: Boolean) : BrowserLiveMessage
    data object Heartbeat : BrowserLiveMessage
    data class Error(val message: String) : BrowserLiveMessage
}

data class BrowserFrame(
    val seq: Int,
    /** Base64 JPEG or PNG, exactly as the server framed it. */
    val data: String,
    val format: String,
    val deviceWidth: Double,
    val deviceHeight: Double,
)

data class BrowserStatus(
    val connected: Boolean,
    val screencasting: Boolean,
    val viewportWidth: Double,
    val viewportHeight: Double,
)

data class BrowserTab(
    val tabId: String,
    val title: String,
    val url: String,
    val active: Boolean,
)

/**
 * Decodes one server message.
 *
 * Written by hand because the wire is a tagged union keyed on `type`, and
 * because a message we do not understand must be dropped rather than tear
 * down a stream the person is watching.
 *
 * Mirrors CompanionCore's `BrowserLiveDecoder`.
 */
object BrowserLiveDecoder {
    private val json = Json { ignoreUnknownKeys = true }

    private fun JsonObject.string(key: String) = this[key]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.bool(key: String) = this[key]?.jsonPrimitive?.booleanOrNull
    private fun JsonObject.number(key: String) = this[key]?.jsonPrimitive?.doubleOrNull

    /**
     * The message type travels in the SSE `event:` name, not in the payload —
     * the server strips it (`const { type, ...data } = message`) before
     * writing the frame. Keying on the payload instead decoded nothing at all,
     * which is exactly how this was found.
     */
    fun message(event: String?, raw: String): BrowserLiveMessage? {
        if (event == null) return null
        val root = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            ?: JsonObject(emptyMap())

        return when (event) {
            "frame" -> {
                val seq = root["seq"]?.jsonPrimitive?.intOrNull ?: return null
                val data = root.string("data") ?: return null
                val metadata = runCatching { root["metadata"]!!.jsonObject }.getOrNull() ?: return null
                val width = metadata.number("deviceWidth") ?: return null
                val height = metadata.number("deviceHeight") ?: return null
                BrowserLiveMessage.Frame(
                    BrowserFrame(seq, data, root.string("format") ?: "jpeg", width, height),
                )
            }

            "status" -> BrowserLiveMessage.Status(
                BrowserStatus(
                    connected = root.bool("connected") ?: return null,
                    screencasting = root.bool("screencasting") ?: false,
                    viewportWidth = root.number("viewportWidth") ?: 1280.0,
                    viewportHeight = root.number("viewportHeight") ?: 720.0,
                ),
            )

            "url" -> BrowserLiveMessage.Url(root.string("url") ?: return null)

            "tabs" -> {
                val array = runCatching { root["tabs"]!!.jsonArray }.getOrNull() ?: return null
                BrowserLiveMessage.Tabs(
                    array.mapNotNull { element ->
                        val tab = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
                        val id = tab.string("tabId") ?: return@mapNotNull null
                        BrowserTab(
                            tabId = id,
                            title = tab.string("title") ?: "",
                            url = tab.string("url") ?: "",
                            active = tab.bool("active") ?: false,
                        )
                    },
                )
            }

            // The server names this `ready`, and it is the only place a viewer
            // id ever arrives. Without it there is nothing to post against.
            "ready" -> BrowserLiveMessage.Ready(root.string("viewerId") ?: return null)

            "control" -> BrowserLiveMessage.Control(
                controlling = root.bool("controlling") ?: false,
                held = root.bool("held") ?: false,
            )

            "heartbeat" -> BrowserLiveMessage.Heartbeat

            "error" -> BrowserLiveMessage.Error(
                root.string("message") ?: "The browser stream was interrupted.",
            )

            // A name we do not know is a protocol change, not a reason to tear
            // down a stream the person is watching.
            else -> null
        }
    }
}

/** Decoded frame bytes, or null when the base64 was not what it claimed.
 *
 * java.util.Base64 rather than android.util.Base64: :core is a plain JVM
 * module so its tests run without an emulator, and pulling in an Android type
 * here would end that. */
fun BrowserFrame.bytes(): ByteArray? =
    runCatching { java.util.Base64.getDecoder().decode(data) }.getOrNull()

/**
 * The browser-live transport: one SSE stream in, one action channel out.
 *
 * Mirrors CompanionCore's `BrowserLiveClient`.
 */
class BrowserLiveTransport internal constructor(
    private val base: HttpUrl,
    private val token: String?,
    private val streamClient: OkHttpClient,
    private val actionClient: OkHttpClient,
) {
    private val jsonMedia = "application/json".toMediaType()

    private fun request(path: String): Request.Builder =
        Request.Builder()
            .url(base.newBuilder().encodedPath(path).build())
            .apply { token?.let { header("Authorization", "Bearer $it") } }

    /**
     * The frame stream. Runs until the server ends it or the collector leaves;
     * reconnection belongs to whatever knows if the view is still on screen,
     * exactly as it does for the main event stream.
     */
    fun live(botId: String): Flow<BrowserLiveMessage> = callbackFlow {
        val call = streamClient.newCall(request("/api/bots/$botId/browser/live").get().build())
        val responseRef = AtomicReference<Response?>(null)
        val reader = launch(Dispatchers.IO) {
            try {
                val response = call.execute()
                responseRef.set(response)
                // Read the refusal rather than discard it. Throwing a bare
                // status made every 403 read as "browser control is off",
                // whatever the server actually said.
                if (response.code != 200) {
                    throw APIError.Status(response.code, browserErrorText(response.peekBody(4096).string()))
                }
                val body = response.body ?: throw APIError.Transport("The browser sent an empty stream.")
                val source = body.source()
                val parser = SSEParser()

                while (isActive) {
                    val line = source.readUtf8Line() ?: break
                    val event = parser.line(line) ?: continue
                    val message = BrowserLiveDecoder.message(event.event, event.data) ?: continue
                    send(message)
                }
                parser.reset()
                close()
            } catch (_: CancellationException) {
                // A collector leaving the flow deliberately tears down the call.
            } catch (error: APIError) {
                close(error)
            } catch (error: IOException) {
                close(APIError.Transport(error.message ?: "Could not reach the browser.", error))
            } finally {
                responseRef.getAndSet(null)?.close()
            }
        }

        awaitClose {
            responseRef.getAndSet(null)?.close()
            call.cancel()
            reader.cancel()
        }
    }

    /**
     * One action. The server answers only after the browser has applied it,
     * which is what makes the queue's one-in-flight rule necessary.
     */
    suspend fun action(botId: String, viewerId: String, body: JsonObject) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            body.forEach { (key, value) -> put(key, value) }
            put("viewerId", viewerId)
        }
        val request = request("/api/bots/$botId/browser/action")
            .post(payload.toString().toRequestBody(jsonMedia))
            .build()
        actionClient.newCall(request).execute().use { response ->
            if (response.code != 200) {
                throw APIError.Status(response.code, browserErrorText(response.peekBody(4096).string()))
            }
        }
    }

    /** An input body, posted through the same channel. */
    suspend fun send(botId: String, viewerId: String, input: BrowserInputBody) {
        val encoded = Json.encodeToJsonElement(BrowserInputBody.serializer(), input).jsonObject
        action(botId, viewerId, encoded)
    }
}

/** The `error` field of a JSON refusal, which is how both the sidecar and the
 * harness explain themselves. Null for anything else. */
fun browserErrorText(body: String): String? = runCatching {
    Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
}.getOrNull()
