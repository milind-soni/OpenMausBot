package com.openmausbot.companion.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import com.openmausbot.companion.core.AttachmentPolicy
import com.openmausbot.companion.core.PendingMessageAttachment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * What the composer decides about attachments and downloaded files, read off
 * `ios/App/ChatView.swift` (#695) and `AttachmentViews.swift`.
 */
class AttachmentRulesTest {
    private fun pending(bytes: Int, kind: PendingMessageAttachment.Kind = PendingMessageAttachment.Kind.FILE) =
        PendingMessageAttachment(data = ByteArray(bytes), name = "a.txt", mime = "text/plain", kind = kind)

    @Test
    fun `photos are named for their count`() {
        assertEquals("Photo.jpg", AttachmentImportRules.photoName(0, 1, "jpg"))
        assertEquals("Photo 1.png", AttachmentImportRules.photoName(0, 2, "png"))
        assertEquals("Photo 2.png", AttachmentImportRules.photoName(1, 2, "png"))
        assertEquals("webp", AttachmentImportRules.extensionForImageMime("image/webp"))
        assertEquals("jpg", AttachmentImportRules.extensionForImageMime("image/heic"))
    }

    @Test
    fun `a read is bounded by the item cap or the total's remainder, whichever is smaller`() {
        assertEquals(AttachmentPolicy.MAXIMUM_TOTAL_BYTES, AttachmentImportRules.remainingBytes(emptyList()))
        assertEquals(AttachmentPolicy.MAXIMUM_TOTAL_BYTES - 1_000, AttachmentImportRules.remainingBytes(listOf(pending(1_000))))
        assertEquals(AttachmentPolicy.MAXIMUM_IMAGE_BYTES, AttachmentImportRules.readLimit(PendingMessageAttachment.Kind.IMAGE, Int.MAX_VALUE))
        assertEquals(AttachmentPolicy.MAXIMUM_FILE_BYTES, AttachmentImportRules.readLimit(PendingMessageAttachment.Kind.FILE, Int.MAX_VALUE))
        assertEquals(500, AttachmentImportRules.readLimit(PendingMessageAttachment.Kind.FILE, 500))
    }

    @Test
    fun `adding stops at four and while anything is in flight`() {
        assertTrue(AttachmentImportRules.canAdd(3, preparing = false, sending = false))
        assertFalse(AttachmentImportRules.canAdd(4, preparing = false, sending = false))
        assertFalse(AttachmentImportRules.canAdd(0, preparing = true, sending = false))
        assertFalse(AttachmentImportRules.canAdd(0, preparing = false, sending = true))
    }

    @Test
    fun `sending needs text or an attachment, and nothing in flight`() {
        assertFalse(AttachmentImportRules.canSend("  ", 0, preparing = false, sending = false))
        assertTrue(AttachmentImportRules.canSend("hi", 0, preparing = false, sending = false))
        assertTrue(AttachmentImportRules.canSend("", 1, preparing = false, sending = false))
        assertFalse(AttachmentImportRules.canSend("hi", 1, preparing = true, sending = false))
        assertFalse(AttachmentImportRules.canSend("hi", 1, preparing = false, sending = true))
    }

    @Test
    fun `sizes read the way the Swift's byte formatter prints them`() {
        assertEquals("512 bytes", AttachmentImportRules.formatBytes(512))
        assertEquals("48 KB", AttachmentImportRules.formatBytes(48_000))
        assertEquals("1.2 MB", AttachmentImportRules.formatBytes(1_200_000))
        assertEquals("a.txt is larger than the 25.0 MB remaining attachment limit.", AttachmentImportRules.tooLarge("a.txt", 25_000_000))
    }

    @Test
    fun `a downloaded file is shown by its type, then its suffix`() {
        assertEquals(FilePreviewKind.IMAGE, FilePreviewRules.kind("image/png", "x.bin"))
        assertEquals(FilePreviewKind.IMAGE, FilePreviewRules.kind("application/octet-stream", "photo.webp"))
        assertEquals(FilePreviewKind.MARKDOWN, FilePreviewRules.kind("text/markdown", "x.bin"))
        assertEquals(FilePreviewKind.MARKDOWN, FilePreviewRules.kind("application/octet-stream", "README.md"))
        assertEquals(FilePreviewKind.TEXT, FilePreviewRules.kind("text/plain", "notes"))
        assertEquals(FilePreviewKind.TEXT, FilePreviewRules.kind("application/json", "data.json"))
        assertEquals(FilePreviewKind.OTHER, FilePreviewRules.kind("application/pdf", "report.pdf"))
        assertEquals("report.pdf", FilePreviewRules.nameForOpening("/Users/x/report.pdf"))
        assertEquals("report.pdf", FilePreviewRules.nameForOpening("""C:\Users\x\report.pdf"""))
    }

    @Test
    fun `large attachment images decode near the requested display edge`() {
        assertEquals(4, AttachmentImageRules.sampleSize(4_000, 2_000, 768))
        assertEquals(2, AttachmentImageRules.sampleSize(1_600, 1_200, 768))
        assertEquals(1, AttachmentImageRules.sampleSize(700, 500, 768))
        assertEquals(1, AttachmentImageRules.sampleSize(0, 500, 768))
        assertEquals(IntSize(768, 384), AttachmentImageRules.targetSize(4_000, 2_000, 768))
        assertEquals(IntSize(500, 700), AttachmentImageRules.targetSize(500, 700, 768))
    }

    @Test
    fun `android eight sampling bounds its intermediate without needless blur`() {
        assertEquals(4, AttachmentImageRules.legacySampleSize(4_000, 3_000, 768))
        // The no-undershoot plan is sample 2 (36 MP). One extra step yields a
        // 3000 px edge, just below 3072, and a bounded 9 MP allocation.
        assertEquals(4, AttachmentImageRules.legacySampleSize(12_000, 12_000, 3_072))
        // Just over the soft 12 MP budget but close to the requested edge: keep
        // the sharp source under the 14 MP hard cap, then scale to 3072 exactly.
        assertEquals(1, AttachmentImageRules.legacySampleSize(3_500, 3_500, 3_072))
        // The tolerance is hard bounded; a materially larger allocation still samples.
        assertEquals(2, AttachmentImageRules.legacySampleSize(4_000, 4_000, 3_072))
        assertEquals(1, AttachmentImageRules.legacySampleSize(700, 500, 768))
    }

    @Test
    fun `computer screenshot budget follows rendered width and source aspect`() {
        assertEquals(1_200, ScreenShotImageRules.maximumEdge(1_200, 2_400, 1_200))
        assertEquals(2_400, ScreenShotImageRules.maximumEdge(1_200, 1_200, 2_400))
        assertEquals(600, ScreenShotImageRules.maximumEdge(1_200, 600, 300))
        assertEquals(4_096, ScreenShotImageRules.maximumEdge(2_000, 1_000, 5_000))
    }

    @Test
    fun `zoomed image pan stays inside the visible content`() {
        assertEquals(
            Offset(500f, 0f),
            ImagePanRules.clamp(
                offset = Offset(9_000f, 9_000f),
                scale = 2f,
                viewport = IntSize(1_000, 1_000),
                image = IntSize(2_000, 1_000),
            ),
        )
        assertEquals(
            Offset.Zero,
            ImagePanRules.clamp(Offset(20f, 20f), 1f, IntSize(1_000, 1_000), IntSize(2_000, 1_000)),
        )
    }

    @Test
    fun `a text preview is cut at two megabytes and says so`() {
        val small = "hello".toByteArray()
        assertEquals("hello", FilePreviewRules.text(small))
        val large = ByteArray(FilePreviewRules.TEXT_LIMIT_BYTES + 1) { 'a'.code.toByte() }
        val text = FilePreviewRules.text(large)
        assertTrue(text.endsWith(FilePreviewRules.TRUNCATED_NOTE))
        assertEquals(FilePreviewRules.TEXT_LIMIT_BYTES, text.length - FilePreviewRules.TRUNCATED_NOTE.length)
    }

    @Test
    fun `a pending attachment hides the chips the way a draft does`() {
        assertEquals(
            ComposerAccessory.NONE,
            ComposerAccessories.accessory(hudOpen = false, draft = "", busy = false, pendingApproval = false, hasQuickReplies = true, hasAttachments = true),
        )
        assertEquals(
            ComposerAccessory.CHIPS,
            ComposerAccessories.accessory(hudOpen = false, draft = "", busy = false, pendingApproval = false, hasQuickReplies = true, hasAttachments = false),
        )
    }

    @Test
    fun `the sheet greys the attachment rows at the cap`() {
        val actions = ChatActions.sheet(com.openmausbot.companion.core.Chat.BotChat(bot()), hasPendingApproval = false, canAddAttachment = false)
        assertFalse(actions.single { it.id == ChatActionId.PHOTOS }.enabled)
        assertFalse(actions.single { it.id == ChatActionId.FILES }.enabled)
        assertTrue(actions.single { it.id == ChatActionId.TASKS }.enabled)
    }
}
