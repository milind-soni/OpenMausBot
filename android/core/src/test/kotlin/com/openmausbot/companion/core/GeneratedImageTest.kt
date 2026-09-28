package com.openmausbot.companion.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class GeneratedImageTest {
    @Test
    fun generatedImagesSurviveMessageDecodeAndCacheRoundTrip() {
        val json = Json { ignoreUnknownKeys = true }
        val source = """{"id":"reply","role":"bot","kind":"text","at":1,"text":"Screenshot attached","attachments":[{"kind":"image","path":"/tmp/screenshot.png","mime":"image/png"}]}"""
        val message = json.decodeFromString<Message>(source)
        val stored = json.parseToJsonElement(json.encodeToString(message)).jsonObject
        assertEquals("/tmp/screenshot.png", stored["attachments"]?.jsonArray?.first()?.jsonObject?.get("path")?.jsonPrimitive?.content)
    }

    @Test
    fun imageOnlyReplyIgnoresFutureKindsAndDuplicatePaths() {
        val source = """{"id":"reply","role":"bot","kind":"text","at":1,"attachments":[{"kind":"video"},{"kind":"audio","path":"/tmp/note.mp3","mime":"audio/mpeg","durationMs":4200},{"kind":"image","path":"/tmp/screen 100%.png","mime":"image/png"},{"kind":"image","path":"/tmp/screen 100%.png"},{"kind":"image","path":" "}]}"""
        val message = CompanionJson.decodeFromString<Message>(source)
        assertEquals(listOf(DisplayedMessageAttachment(DisplayedMessageAttachment.Kind.IMAGE, "screen 100%.png", "/tmp/screen 100%.png")), message.generatedImages)
        val state = CompanionState().apply(Frame.Message("thread", message.copy(attachments = null)))
            .apply(Frame.MessagePatch("thread", message))
        assertEquals(message.generatedImages, state.transcript("thread").single().generatedImages)
        assertEquals(null, message.text)
    }

    @Test
    fun legacyTextHasNoGeneratedImages() {
        val message = Json.decodeFromString<Message>("""{"id":"old","role":"bot","kind":"text","at":1,"text":"Still visible"}""")
        assertEquals(emptyList(), message.generatedImages)
        assertEquals("Still visible", message.text)
    }
}
