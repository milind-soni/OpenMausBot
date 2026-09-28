package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The decode half of the voice-note bubble contract: audio in, parked mp3s out. */
class VoiceNotesTest {

    private fun reply(attachmentsJson: String): Message = CompanionJson.decodeFromString(
        """{"id":"reply","role":"bot","kind":"text","at":1,"text":"Held note","attachments":[$attachmentsJson]}""",
    )

    @Test
    fun audioAttachmentCarriesItsDurationEstimate() {
        val note = reply(
            """{"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3","mime":"audio/mpeg","durationMs":4200}""",
        ).voiceNotes.single()

        assertEquals(DisplayedMessageAttachment.Kind.AUDIO, note.kind)
        assertEquals("/attachments/123e4567-e89b-12d3-a456-426614174000.mp3", note.path)
        assertEquals("Voice note", note.name)
        assertEquals(4200.0, note.durationMs)
    }

    @Test
    fun onlyParkedGeneratedMp3NamesBecomePlayers() {
        val message = reply(
            """
            {"kind":"audio","path":"/attachments/note.wav","mime":"audio/wav"},
            {"kind":"audio","path":"/attachments/clip.mp4","mime":"audio/mp4"},
            {"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3","mime":"audio/mpeg"},
            {"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3"},
            {"kind":"audio","path":" "},
            {"kind":"video","path":"/attachments/clip.mp4"},
            {"kind":"image","path":"/tmp/screen.png","mime":"image/png"}
            """.trimIndent(),
        )

        assertEquals(
            listOf("/attachments/123e4567-e89b-12d3-a456-426614174000.mp3"),
            message.voiceNotes.map(DisplayedMessageAttachment::path),
        )
        assertNull(message.voiceNotes.single().durationMs)
    }

    @Test
    fun legacyRepliesDecodeWithoutAudioFields() {
        val message = CompanionJson.decodeFromString<Message>(
            """{"id":"old","role":"bot","kind":"text","at":1,"text":"Still visible","attachments":[{"kind":"image","path":"/tmp/s.png"}]}""",
        )

        assertTrue(message.voiceNotes.isEmpty())
        assertNull(message.attachments?.single()?.durationMs)
        assertEquals(1, message.generatedImages.size)
    }
}
