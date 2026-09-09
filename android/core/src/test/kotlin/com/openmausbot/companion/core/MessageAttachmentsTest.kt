package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The port of `ios/Tests/CompanionCoreTests/MessageAttachmentsTests.swift`. */
class MessageAttachmentsTest {

    @Test
    fun classifiesWebAndAbsoluteDesktopLinks() {
        assertEquals(
            LocalMessageLink.Web("https://example.com/report.md?q=1"),
            LocalMessageLink.resolve("https://example.com/report.md?q=1"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("/Users/milind/Documents/report.md"),
            LocalMessageLink.resolve("/Users/milind/Documents/report.md"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("/Users/milind/My Report.md"),
            LocalMessageLink.resolve("file:///Users/milind/My%20Report.md"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("""C:\Users\Milind\report.md"""),
            LocalMessageLink.resolve("""C:\Users\Milind\report.md"""),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("C:/Users/Milind/report.md"),
            LocalMessageLink.resolve("file:///C:/Users/Milind/report.md"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("""\\server\share\report.md"""),
            LocalMessageLink.resolve("""\\server\share\report.md"""),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("""\\server\share\report.md"""),
            LocalMessageLink.resolve("file://server/share/report.md"),
        )
        assertEquals(
            LocalMessageLink.Web("https://files.example.com/report.md"),
            LocalMessageLink.resolve("//files.example.com/report.md"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("docs/My Report.md"),
            LocalMessageLink.resolve("docs/My Report.md"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("./reports/Quarter One.md"),
            LocalMessageLink.resolve("./reports/Quarter%20One.md?download=1#latest"),
        )
        assertEquals(
            LocalMessageLink.DesktopFile("/C:/posix/report.md"),
            LocalMessageLink.resolve("/C:/posix/report.md"),
        )
    }

    @Test
    fun rejectsMalformedEmptyAndCustomSchemeLinks() {
        assertNull(LocalMessageLink.resolve("#section"))
        assertNull(LocalMessageLink.resolve("?download=1"))
        assertNull(LocalMessageLink.resolve("openmausbot://pair?token=secret"))
        assertNull(LocalMessageLink.resolve("javascript:alert(1)"))
        assertNull(LocalMessageLink.resolve("https:///missing-host.md"))
        assertNull(LocalMessageLink.resolve("file:///tmp/report.md?replace=1"))
        assertNull(LocalMessageLink.resolve("docs/bad%ZZ.md"))
        assertNull(LocalMessageLink.resolve("/tmp/bad\u0000name.md"))
        assertNull(LocalMessageLink.resolve(""))
    }

    @Test
    fun portableFilenamesNeverSplitUnicodeOrExceedTheirByteBudget() {
        val name = sanitisePortableFilename("📄".repeat(100) + ".md", "file")
        assertFalse(name.indices.any { index ->
            val value = name[index]
            (Character.isHighSurrogate(value) &&
                (index + 1 >= name.length || !Character.isLowSurrogate(name[index + 1]))) ||
                (Character.isLowSurrogate(value) &&
                    (index == 0 || !Character.isHighSurrogate(name[index - 1])))
        })
        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 180)
        assertEquals("bad name.txt", sanitisePortableFilename("bad\uD800name.txt", "file"))
    }

    @Test
    fun attachmentPolicyAcceptsSupportedImageAndMarkdown() {
        AttachmentPolicy.validate(
            listOf(
                PendingMessageAttachment(data = byteArrayOf(0x89.toByte(), 0x50), name = "photo.png", mime = "IMAGE/PNG; charset=binary", kind = PendingMessageAttachment.Kind.IMAGE),
                PendingMessageAttachment(data = "# Notes".toByteArray(), name = "notes.md", mime = "text/markdown", kind = PendingMessageAttachment.Kind.FILE),
            ),
        )
        assertEquals(PendingMessageAttachment.Kind.IMAGE, AttachmentPolicy.kindForMime(" IMAGE/JPEG "))
        assertEquals(PendingMessageAttachment.Kind.FILE, AttachmentPolicy.kindForMime("application/pdf"))
        assertNull(AttachmentPolicy.kindForMime("application/zip"))
    }

    @Test
    fun attachmentPolicyRejectsCountTypeNameAndSize() {
        val valid = PendingMessageAttachment(data = byteArrayOf(1), name = "notes.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE)
        assertEquals(
            AttachmentPolicy.TOO_MANY_ITEMS,
            assertFailsWith<AttachmentPolicyException> { AttachmentPolicy.validate(List(5) { valid }) }.message,
        )
        assertEquals(
            "archive.zip isn't a supported file. Try PDF, text, Word, Excel, or PowerPoint.",
            assertFailsWith<AttachmentPolicyException> {
                AttachmentPolicy.validate(listOf(PendingMessageAttachment(data = byteArrayOf(1), name = "archive.zip", mime = "application/zip", kind = PendingMessageAttachment.Kind.FILE)))
            }.message,
        )
        assertEquals(
            AttachmentPolicy.INVALID_NAME,
            assertFailsWith<AttachmentPolicyException> {
                AttachmentPolicy.validate(listOf(PendingMessageAttachment(data = byteArrayOf(1), name = "../notes.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE)))
            }.message,
        )
        assertEquals(
            "huge.png is larger than 10 MB.",
            assertFailsWith<AttachmentPolicyException> {
                AttachmentPolicy.validate(listOf(PendingMessageAttachment(data = ByteArray(AttachmentPolicy.MAXIMUM_IMAGE_BYTES + 1), name = "huge.png", mime = "image/png", kind = PendingMessageAttachment.Kind.IMAGE)))
            }.message,
        )
    }
}
