package com.astra.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SseTest {
    private fun events(lines: List<String>): List<SSEEvent> {
        val parser = SSEParser()
        return lines.mapNotNull(parser::line)
    }

    @Test
    fun readsOneFrameTheHarnessActuallySends() {
        val parsed = events(listOf("id: 778d5d30:4", """data: {"kind":"bot","seq":4}""", ""))
        assertEquals(1, parsed.size)
        assertEquals("778d5d30:4", parsed[0].id)
        assertEquals("""{"kind":"bot","seq":4}""", parsed[0].data)
    }

    @Test
    fun swallowsKeepaliveComments() {
        assertTrue(events(listOf(": keepalive", "")).isEmpty())
        assertEquals(1, events(listOf(": keepalive", "", "data: {}", "")).size)
    }

    @Test
    fun emitsNothingUntilTheBlankLineArrives() {
        val parser = SSEParser()
        assertNull(parser.line("id: s:1"))
        assertNull(parser.line("data: {}"))
        assertNotNull(parser.line(""))
    }

    @Test
    fun joinsMultipleDataLines() {
        val parsed = events(listOf("data: {", "data: \"kind\": \"hello\"", "data: }", ""))
        assertEquals("{\n\"kind\": \"hello\"\n}", parsed.first().data)
    }

    @Test
    fun handlesOptionalSpaceAndCarriageReturns() {
        assertEquals("tight", events(listOf("data:tight", "")).first().data)
        assertEquals(" padded", events(listOf("data:  padded", "")).first().data)
        assertEquals("crlf", events(listOf("data: crlf\r", "\r")).first().data)
    }

    @Test
    fun ignoresUnusedFieldsAndBlocksWithoutData() {
        assertTrue(events(listOf("event: ping", "retry: 3000", "")).isEmpty())
        assertTrue(events(listOf("", "", "")).isEmpty())
        assertTrue(events(listOf("garbage-with-no-colon", "")).isEmpty())
    }

    @Test
    fun fieldsDoNotLeakIntoTheNextEvent() {
        val parser = SSEParser()
        parser.line("id: s:1")
        parser.line("data: first")
        val first = parser.line("")
        parser.line("data: second")
        val second = parser.line("")
        assertEquals("s:1", first?.id)
        assertEquals("second", second?.data)
        assertNull(second?.id)
    }

    @Test
    fun resetDiscardsAnIncompleteEventAtEof() {
        val parser = SSEParser()
        parser.line("id: s:1")
        parser.line("data: incomplete")
        parser.reset()
        assertNull(parser.line(""))
    }

    @Test
    fun fullStreamDecodesIntoFrames() {
        val lines = listOf(
            """data: {"kind":"hello","cursor":"abc12345:0","resumed":false}""", "",
            ": keepalive", "",
            "id: abc12345:1",
            """data: {"kind":"message","threadId":"t1","seq":1,"message":{"id":"m1","role":"user","kind":"text","at":1}}""",
            "",
        )
        val frames = events(lines).mapNotNull {
            runCatching { CompanionJson.decodeFromString<StreamFrame>(it.data) }.getOrNull()
        }
        assertEquals(2, frames.size)
        val hello = assertIs<Frame.Hello>(frames[0].frame)
        assertEquals("abc12345:0", hello.cursor)
        assertFalse(hello.resumed)
        assertIs<Frame.Message>(frames[1].frame)
        assertEquals(1, frames[1].seq)
    }
}
