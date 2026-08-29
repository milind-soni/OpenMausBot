package com.openmausbot.chief.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.TimeUnit

class ApiException(message: String, val status: Int? = null) : IOException(message)

class OpenMausApi(
    private val session: PairedSession,
    client: OkHttpClient = defaultClient(),
) {
    private val client = client.newBuilder()
        .addInterceptor(ConnectionFallbackInterceptor(session.connection))
        .build()
    suspend fun fleet(messages: Int = 80): Fleet = get("/api/bots?messages=$messages")
    suspend fun thread(threadId: String, before: String? = null): ThreadPage =
        get("/api/threads/${safeId(threadId)}/messages?limit=80${before?.let { "&before=${safeId(it)}" }.orEmpty()}")
    suspend fun routines(): RoutinesResponse = get("/api/routines")

    /** Register or rotate the FCM target for this already-paired phone. */
    suspend fun registerPushToken(token: String) = postUnit(
        "/api/companion/push-token",
        buildJsonObject { put("token", token) },
        method = "PUT",
    )

    /** Remove this phone's FCM target when the pairing is revoked locally. */
    suspend fun revokePushToken() = postUnit(
        "/api/companion/push-token",
        JsonObject(emptyMap()),
        method = "DELETE",
    )

    suspend fun mirrorNotification(payload: NotificationMirrorPayload) = postUnit(
        "/api/companion/notification-mirror",
        buildJsonObject {
            put("id", payload.id)
            put("packageName", payload.packageName)
            put("postedAt", payload.postedAt)
            put("title", payload.title)
            put("text", payload.text)
            payload.conversationTitle?.let { put("conversationTitle", it) }
            payload.sender?.let { put("sender", it) }
        },
    )

    /** Send a content-free liveness receipt for the notification mirror. */
    suspend fun mirrorHeartbeat() = postUnit(
        "/api/companion/notification-mirror/heartbeat",
        JsonObject(emptyMap()),
    )

    suspend fun send(botId: String, text: String) = postUnit(
        "/api/bots/${safeId(botId)}/messages",
        buildJsonObject { put("text", text.take(20_000)) },
    )

    suspend fun interrupt(botId: String) = postUnit("/api/bots/${safeId(botId)}/interrupt", JsonObject(emptyMap()))
    suspend fun markRead(botId: String) = postUnit("/api/bots/${safeId(botId)}/read", JsonObject(emptyMap()))
    suspend fun computerScreenshot(botId: String): ComputerScreenFrame =
        post("/api/bots/${safeId(botId)}/computer/screenshot", JsonObject(emptyMap()))

    suspend fun respond(threadId: String, requestId: String, choice: String, isPermission: Boolean) {
        val behavior = if (isPermission) {
            if (choice.equals("deny", true)) "deny" else "allow"
        } else "answer"
        postUnit(
            "/api/threads/${safeId(threadId)}/respond",
            buildJsonObject {
                put("requestId", requestId)
                put("behavior", behavior)
                put("message", choice)
            },
        )
    }

    suspend fun setRoutineEnabled(routineId: String, enabled: Boolean): Routine =
        patch<RoutineResponse>(
            "/api/routines/${safeId(routineId)}",
            buildJsonObject { put("enabled", enabled) },
        ).routine

    suspend fun runRoutine(routineId: String): RoutineRun =
        post<RoutineRunResponse>("/api/routines/${safeId(routineId)}/run", JsonObject(emptyMap())).run

    suspend fun setReportingMode(botId: String, mode: String): Bot =
        patch<BotResponse>(
            "/api/bots/${safeId(botId)}/profile",
            buildJsonObject { put("reportingMode", mode) },
        ).bot

    fun events(
        cursor: String?,
        screens: Boolean,
        onFrame: (kind: String, payload: JsonObject) -> Unit,
        onFailure: (Throwable) -> Unit,
    ): EventSource {
        val query = buildString {
            append("?screens=").append(if (screens) "on" else "off")
            if (!cursor.isNullOrBlank()) append("&since=").append(cursor)
        }
        val request = request("GET", "/api/events$query").header("Accept", "text/event-stream").build()
        return EventSources.createFactory(client).newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val value = runCatching { WireJson.parseToJsonElement(data).jsonObject }.getOrNull() ?: return
                val kind = value["kind"]?.jsonPrimitive?.content ?: type ?: return
                onFrame(kind, value)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                onFailure(t ?: ApiException("Live connection closed", response?.code))
            }
        })
    }

    private suspend inline fun <reified T> get(path: String): T = execute(request("GET", path).build())
    private suspend inline fun <reified T> post(path: String, body: JsonObject): T = execute(jsonRequest("POST", path, body))
    private suspend inline fun <reified T> patch(path: String, body: JsonObject): T = execute(jsonRequest("PATCH", path, body))
    private suspend fun postUnit(path: String, body: JsonObject, method: String = "POST") {
        executeUnit(jsonRequest(method, path, body))
    }

    private fun jsonRequest(method: String, path: String, body: JsonObject): Request =
        request(method, path)
            .method(method, body.toString().toRequestBody(JSON_MEDIA))
            .build()

    private fun request(method: String, path: String): Request.Builder {
        val origin = validatedOrigin(session.connection)
        val url = origin.trimEnd('/') + path
        return Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${session.token}")
            .header("Accept", "application/json")
    }

    private suspend inline fun <reified T> execute(request: Request): T = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw apiError(response.code, body)
            WireJson.decodeFromString<T>(body)
        }
    }

    private suspend fun executeUnit(request: Request) = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw apiError(response.code, body)
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        private val safeIdPattern = Regex("^[A-Za-z0-9_-]+$")

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false)
            .retryOnConnectionFailure(true)
            .build()

        suspend fun pair(invite: PairingInvite, deviceName: String, client: OkHttpClient = defaultClient()): PairedSession =
            withContext(Dispatchers.IO) {
                val health = Request.Builder().url(invite.connection.origin.trimEnd('/') + "/api/health").get().build()
                client.newCall(health).execute().use { response ->
                    val body = response.body.string()
                    val identity = runCatching { WireJson.decodeFromString<HealthIdentity>(body) }.getOrNull()
                    if (!response.isSuccessful || identity?.app != "openmausbot") {
                        throw ApiException("That computer is not running Agent Centipede.")
                    }
                }
                val credentialKey = if (invite.credential.matches(Regex("^\\d{6}$"))) "code" else "credential"
                val payload = buildJsonObject {
                    put(credentialKey, invite.credential)
                    put("deviceName", deviceName.take(80))
                    put("pairRequestId", UUID.randomUUID().toString())
                }
                val request = Request.Builder()
                    .url(invite.connection.origin.trimEnd('/') + "/api/pair")
                    .post(payload.toString().toRequestBody(JSON_MEDIA))
                    .header("Accept", "application/json")
                    .build()
                client.newCall(request).execute().use { response ->
                    val body = response.body.string()
                    if (!response.isSuccessful) throw apiError(response.code, body)
                    val paired = WireJson.decodeFromString<PairResponse>(body)
                    val advertised = paired.endpoints.orEmpty().mapNotNull { it.validated() }
                    val permitted = advertised.filter { endpoint ->
                        endpoint.kind in invite.connection.allowedKinds &&
                            (endpoint.kind !in setOf("lan", "bonjour") || endpoint.url in invite.connection.allowedLocalOrigins)
                    }
                    val active = permitted.firstOrNull { it.url == invite.connection.origin }
                        ?: invite.connection.endpoints.firstOrNull { it.url == invite.connection.origin }
                        ?: throw ApiException("The paired route changed before setup completed. Scan a new code.")
                    val saved = invite.connection.copy(
                        name = paired.serverName.take(80),
                        origin = active.url,
                        endpoints = (listOf(active) + permitted).distinctBy { it.url },
                    )
                    PairedSession(saved, paired.token)
                }
            }

        private fun validatedOrigin(connection: SavedConnection): String {
            val endpoint = approvedEndpoints(connection).firstOrNull { it.url == connection.origin }
                ?: throw ApiException("Saved connection is invalid.")
            return endpoint.url
        }

        private fun approvedEndpoints(connection: SavedConnection): List<CompanionEndpoint> =
            connection.endpoints
                .mapNotNull { it.validated() }
                .filter { endpoint ->
                    endpoint.kind in connection.allowedKinds &&
                        (endpoint.kind !in setOf("lan", "bonjour") || endpoint.url in connection.allowedLocalOrigins)
                }
                .distinctBy { it.url }
                .sortedWith(compareBy<CompanionEndpoint> { it.url != connection.origin }.thenBy { it.priority })

        private fun safeId(value: String): String {
            if (!safeIdPattern.matches(value)) throw ApiException("Invalid identifier")
            return value
        }

        private fun apiError(status: Int, body: String): ApiException {
            val message = runCatching { WireJson.decodeFromString<ApiErrorBody>(body).error }.getOrNull()
                ?: "Agent Centipede returned HTTP $status"
            return ApiException(message, status)
        }
    }

    private class ConnectionFallbackInterceptor(connection: SavedConnection) : Interceptor {
        private val origins = approvedEndpoints(connection).map { it.url.toHttpUrl() }

        override fun intercept(chain: Interceptor.Chain): Response {
            val original = chain.request()
            var lastFailure: IOException? = null
            for (origin in origins) {
                val url = origin.newBuilder()
                    .encodedPath(original.url.encodedPath)
                    .encodedQuery(original.url.encodedQuery)
                    .build()
                try {
                    return chain.proceed(original.newBuilder().url(url).build())
                } catch (failure: IOException) {
                    if (!isPreDeliveryConnectionFailure(failure)) throw failure
                    lastFailure = failure
                }
            }
            throw lastFailure ?: ApiException("Saved connection is invalid.")
        }

        private fun isPreDeliveryConnectionFailure(failure: IOException): Boolean {
            var current: Throwable? = failure
            val visited = mutableSetOf<Throwable>()
            while (current != null && visited.add(current)) {
                if (current is UnknownHostException || current is ConnectException || current is NoRouteToHostException) {
                    return true
                }
                current = current.cause
            }
            return false
        }
    }
}
