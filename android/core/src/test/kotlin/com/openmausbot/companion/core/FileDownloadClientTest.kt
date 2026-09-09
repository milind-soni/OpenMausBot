package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The authenticated file route — the download half of `ShareClientTests.swift`. */
class FileDownloadClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun postsThePathAndSanitisesResponseMetadata() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "Text/Markdown; charset=utf-8")
                .setHeader("Content-Disposition", "attachment; filename*=UTF-8''Quarter%20Report.md")
                .setBody("# Report"),
        )

        val file = client.downloadFile("thread-1", "message-1", "/Users/test/Documents/report.md")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/threads/thread-1/messages/message-1/file", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("path"), body.keys)
        assertEquals("/Users/test/Documents/report.md", body.getValue("path").jsonPrimitive.content)
        assertContentEquals("# Report".toByteArray(), file.data)
        assertEquals("Quarter Report.md", file.filename)
        assertEquals("text/markdown", file.contentType)
    }

    @Test
    fun stripsPathAndControlsFromTheResponseFilename() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "not a mime")
                .setHeader("Content-Disposition", "attachment; filename=\"../secret.txt\"")
                .setBody(Buffer().write(byteArrayOf(1))),
        )

        val file = client.downloadFile("thread-1", "message-1", "/Users/test/fallback.txt")

        assertEquals("secret.txt", file.filename)
        assertEquals("application/octet-stream", file.contentType)
    }

    @Test
    fun blanksControlAndBidiOverrideCharactersInAServerChosenName() {
        // OkHttp refuses to carry the raw header, so the sanitiser is exercised directly.
        assertEquals("secret .txt", CompanionClient.downloadFilename("attachment; filename=\"../secret\u202E.txt\"", "/x"))
        assertEquals("file", CompanionClient.downloadFilename("attachment; filename=\"..\"", "/"))
        assertEquals("a b.txt", CompanionClient.downloadFilename("attachment; filename=\"a\tb.txt\"", "/x"))
    }

    @Test
    fun canonicalFilenameTruncationPreservesUnicodeScalarsAndUtf8Limit() {
        val original = "📄".repeat(100) + ".md"
        val name = CompanionClient.downloadFilename("attachment; filename=\"$original\"", "/fallback.md")

        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 180)
        assertFalse(name.indices.any { index ->
            val value = name[index]
            (Character.isHighSurrogate(value) &&
                (index + 1 >= name.length || !Character.isLowSurrogate(name[index + 1]))) ||
                (Character.isLowSurrogate(value) &&
                    (index == 0 || !Character.isHighSurrogate(name[index - 1])))
        })
    }

    @Test
    fun fallsBackToTheRequestedPathsBasename() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody("x"))
        val file = client.downloadFile("thread-1", "message-1", "/Users/test/notes/todo.txt")
        assertEquals("todo.txt", file.filename)
    }

    @Test
    fun rejectsAnUnsafeRequestBeforeNetworking() = runBlocking {
        assertFailsWith<APIError.BadUrl> { client.downloadFile("../thread", "message-1", "relative/report.md") }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun postsDecodedRelativeMarkdownPathThroughTheScopedRoute() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/markdown")
                .setHeader("Content-Disposition", "attachment; filename=report.md")
                .setBody("# Report"),
        )

        client.downloadFile("thread-1", "message-1", "docs/Quarter%20Report.md?download=1#latest")

        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("docs/Quarter Report.md", body.getValue("path").jsonPrimitive.content)
    }

    @Test
    fun rejectsAnOversizedDeclaredResponse() = runBlocking {
        server.enqueue(
            MockResponse()
                .setBody("x")
                .setHeader("Content-Type", "text/plain")
                // After setBody, so the declared length is the oversized one.
                .setHeader("Content-Length", (CompanionClient.MAXIMUM_FILE_DOWNLOAD_BYTES + 1).toString())
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_END),
        )
        assertFailsWith<APIError> { client.downloadFile("thread-1", "message-1", "/Users/test/large.txt") }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aServerErrorSurfacesItsMessage() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403).setHeader("Content-Type", "application/json").setBody("""{"error":"that file is outside this conversation"}"""))
        val error = assertFailsWith<APIError.Status> { client.downloadFile("thread-1", "message-1", "/Users/test/x.txt") }
        assertEquals(403, error.code)
        assertEquals("that file is outside this conversation", error.message)
    }
}
