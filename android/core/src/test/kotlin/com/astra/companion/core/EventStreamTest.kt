package com.astra.companion.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class EventStreamTest {
    private val request = Request.Builder().url("http://127.0.0.1:8810/api/events").build()

    @Test
    fun deliversEveryFrameAsItArrives() = runBlocking {
        val body = ChunkedBody(listOf(
            "data: {\"kind\":\"hello\",\"cursor\":\"abc12345:0\",\"resumed\":false}\n\n",
            ": keepalive\n\n",
            "id: abc12345:1\ndata: {\"kind\":\"bot\",\"seq\":1,\"bot\":{\"id\":\"b1\",\"threadId\":\"t1\",\"name\":\"Scout\",\"title\":\"\",\"description\":\"\",\"notifications\":true,\"color\":\"green\",\"unread\":false,\"modelSelection\":{\"instanceId\":\"i\",\"model\":\"m\"},\"createdAt\":1}}\n\n",
            "id: abc12345:2\ndata: {\"kind\":\"message\",\"seq\":2,\"threadId\":\"t1\",\"message\":{\"id\":\"m1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1,\"text\":\"hi\"}}\n\n",
        ))
        val frames = eventStream(request, client(body)).take(3).toList()
        assertEquals(3, frames.size)
        assertIs<Frame.Hello>(frames[0].frame)
        assertIs<Frame.Bot>(frames[1].frame)
        assertIs<Frame.Message>(frames[2].frame)
        assertEquals(2, frames[2].seq)
    }

    @Test
    fun survivesAFrameSplitAcrossReads() = runBlocking {
        val body = ChunkedBody(listOf(
            "data: {\"kind\":\"hel",
            "lo\",\"cursor\":\"abc12345:0\",\"resumed\":true}",
            "\n\n",
        ))
        val frames = eventStream(request, client(body)).take(1).toList()
        val hello = assertIs<Frame.Hello>(frames.single().frame)
        assertEquals("abc12345:0", hello.cursor)
        assertTrue(hello.resumed)
    }

    @Test
    fun reportsUnauthorizedStreamRatherThanEndingQuietly() = runBlocking {
        val error = assertFailsWith<APIError.Status> {
            eventStream(request, client(ChunkedBody(listOf("{\"error\":\"pair this device\"}")), 401)).toList()
        }
        assertTrue(error.isUnauthorized)
    }

    @Test
    fun cancellingConsumerTearsDownTheRequest() = runBlocking {
        val body = ChunkedBody(
            chunks = listOf("data: {\"kind\":\"hello\",\"cursor\":\"abc12345:0\",\"resumed\":false}\n\n"),
            blockAtEnd = true,
        )
        val frames = withTimeout(2_000) {
            eventStream(request, client(body)).take(1).toList()
        }
        assertEquals(1, frames.size)
        assertTrue(body.closed.get(), "leaving the flow should close its response body")
    }

    @Test
    fun malformedFrameIsDroppedWithoutEndingTheStream() = runBlocking {
        val body = ChunkedBody(listOf(
            "data: {not-json}\n\n",
            "data: {\"kind\":\"config\",\"seq\":2}\n\n",
        ))
        val frames = eventStream(request, client(body)).toList()
        assertEquals(1, frames.size)
        assertEquals(Frame.Config, frames.single().frame)
    }

    private fun client(body: ResponseBody, status: Int = 200): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(status)
                .message(if (status == 200) "OK" else "Unauthorized")
                .header("Content-Type", "text/event-stream")
                .body(body)
                .build()
        }
        .build()

    private class ChunkedBody(
        chunks: List<String>,
        private val blockAtEnd: Boolean = false,
    ) : ResponseBody() {
        val closed = AtomicBoolean(false)
        private val release = CountDownLatch(1)
        private val bytes = chunks.map { it.toByteArray() }
        private var index = 0
        private val stream: BufferedSource = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                if (index < bytes.size) {
                    val next = bytes[index++]
                    sink.write(next)
                    return next.size.toLong()
                }
                if (blockAtEnd && !closed.get()) release.await()
                return -1
            }

            override fun timeout(): Timeout = Timeout.NONE

            override fun close() {
                closed.set(true)
                release.countDown()
            }
        }.buffer()

        override fun contentType(): MediaType? = null
        override fun contentLength(): Long = -1
        override fun source(): BufferedSource = stream
    }
}
