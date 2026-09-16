package com.astra.companion.ui

import com.astra.companion.core.APIError
import com.astra.companion.core.BotTask
import com.astra.companion.core.CompanionEndpoint
import com.astra.companion.core.CompanionEndpointKind
import com.astra.companion.core.Connection
import com.astra.companion.core.Fleet
import com.astra.companion.core.Message
import com.astra.companion.core.MessageDestination
import com.astra.companion.core.ModelSelection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SharePolicyTest {
    @Test
    fun destinationsOmitHiddenBotsAndRequireEveryChannelMemberToSeeImages() {
        val vision = bot("vision").copy(modelSelection = ModelSelection("vision", "v"), createdAt = 3.0)
        val text = bot("text").copy(modelSelection = ModelSelection("text", "t"), createdAt = 2.0)
        val hidden = bot("hidden").copy(hidden = true, modelSelection = ModelSelection("vision", "v"), createdAt = 4.0)
        val room = room("room-1").copy(memberIds = listOf("vision", "text"), createdAt = 1.0)
        val capable = setOf("vision")
        val destinations = SharePolicy.destinations(Fleet(listOf(vision, text, hidden), listOf(room)), capable)
        assertEquals(listOf("bot:vision", "bot:text", "channel:room-1"), destinations.map { it.id })
        assertTrue(destinations.first { it.id == "bot:vision" }.supportsImages)
        assertFalse(destinations.first { it.id == "bot:text" }.supportsImages)
        assertFalse(destinations.first { it.id == "channel:room-1" }.supportsImages)
        assertEquals(MessageDestination.Bot("vision", "thread-vision"), destinations.first().destination)
    }

    @Test
    fun destinationsPreferRecentActivityThenName() {
        val older = bot("zeta").copy(
            createdAt = 1.0,
            messages = listOf(message(1.0)),
        )
        val newer = bot("alpha").copy(
            createdAt = 1.0,
            messages = listOf(message(3.0)),
            tasks = listOf(BotTask("thread-alpha", "Research", 2.0)),
        )
        val destinations = SharePolicy.destinations(Fleet(listOf(older, newer), emptyList()), emptySet())
        assertEquals(listOf("bot:alpha", "bot:zeta"), destinations.map { it.id })
        assertEquals("Bot · Research", destinations.first().subtitle)
    }

    @Test
    fun destinationsBreakEqualActivityTiesByNameAscending() {
        val zeta = bot("zeta").copy(
            name = "Zeta",
            createdAt = 5.0,
            messages = listOf(message(5.0)),
        )
        val alpha = bot("alpha").copy(
            name = "Alpha",
            createdAt = 5.0,
            messages = listOf(message(5.0)),
        )
        val destinations = SharePolicy.destinations(Fleet(listOf(zeta, alpha), emptyList()), emptySet())
        assertEquals(listOf("bot:alpha", "bot:zeta"), destinations.map { it.id })
    }

    @Test
    fun rememberedSelectionKeepsALiveChoiceAndFallsBackToTheFirst() {
        val destinations = SharePolicy.destinations(
            Fleet(listOf(bot("a"), bot("b")), emptyList()),
            emptySet(),
        )
        assertEquals("bot:b", SharePolicy.rememberedSelection(destinations, "bot:b"))
        assertEquals("bot:a", SharePolicy.rememberedSelection(destinations, "bot:gone"))
        assertEquals("bot:a", SharePolicy.rememberedSelection(destinations, null))
        assertNull(SharePolicy.rememberedSelection(emptyList(), "bot:a"))
    }

    @Test
    fun imageCompatibilityAndInstructionLimitsGateSend() {
        val vision = SharePolicy.destinations(
            Fleet(listOf(bot("vision").copy(modelSelection = ModelSelection("vision", "v"))), emptyList()),
            setOf("vision"),
        ).single()
        val text = vision.copy(
            id = "bot:text",
            name = "Text",
            supportsImages = false,
            destination = MessageDestination.Bot("text", "thread-text"),
        )
        val preview = SharePolicy.SharePreview(imageCount = 1, attachmentNames = listOf("photo.png"))
        assertNull(SharePolicy.imageCompatibilityMessage(preview, vision))
        assertEquals(
            "Text's current model doesn't support images. Choose another bot or share without the image.",
            SharePolicy.imageCompatibilityMessage(preview, text),
        )
        assertTrue(SharePolicy.canSend(true, preview, vision, ""))
        assertFalse(SharePolicy.canSend(true, preview, text, ""))
        assertFalse(SharePolicy.canSend(true, SharePolicy.SharePreview(), vision, ""))
        assertEquals(
            "Keep the optional instruction under 20,000 characters.",
            SharePolicy.instructionValidationMessage("x".repeat(20_001)),
        )
    }

    @Test
    fun classifyAndUrlRulesMatchTheIosAllowList() {
        assertEquals(SharePolicy.StreamKind.IMAGE, SharePolicy.classifyStream("image/png", null))
        assertEquals(SharePolicy.StreamKind.IMAGE, SharePolicy.classifyStream("image/heic", "photo.heic"))
        assertEquals(SharePolicy.StreamKind.FILE, SharePolicy.classifyStream("application/pdf", "notes.pdf"))
        assertEquals(SharePolicy.StreamKind.FILE, SharePolicy.classifyStream(null, "plan.docx"))
        assertEquals(SharePolicy.StreamKind.FILE, SharePolicy.classifyStream("text/plain", "notes.txt"))
        assertEquals(SharePolicy.StreamKind.TEXT, SharePolicy.classifyStream("text/html", null))
        assertEquals(SharePolicy.StreamKind.URL, SharePolicy.classifyStream("text/x-uri", null))
        assertEquals(SharePolicy.StreamKind.IGNORE, SharePolicy.classifyStream("application/zip", "a.zip"))
        assertTrue(SharePolicy.validWebUrl("https://example.com/story"))
        assertFalse(SharePolicy.validWebUrl("file:///tmp/notes.pdf"))
        assertFalse(SharePolicy.validWebUrl("https://"))
        assertTrue(SharePolicy.tooManyItems(5))
        assertFalse(SharePolicy.tooManyItems(4))
    }

    @Test
    fun hostedRouteLabelAndAmbiguousErrorsStaySpecific() {
        val hosted = CompanionEndpoint.create("https://pair.example", CompanionEndpointKind.HOSTED, 0)!!
        val connection = Connection(id = "air", name = "Air", host = "air.local", port = 8810, activeEndpoint = hosted)
        assertEquals("Secure HTTPS", SharePolicy.routeLabel(connection))
        assertEquals(
            "Automatic",
            SharePolicy.routeLabel(Connection(id = "lan", name = "Lan", host = "10.0.0.2", port = 8810)),
        )
        assertEquals(
            "This phone's pairing has expired. Open Astra and pair it again.",
            SharePolicy.friendlyMessage(APIError.Status(401, "revoked"), "Air"),
        )
        assertEquals(
            "Couldn't reach Air. Keep Astra open and Phone access on, then try again.",
            SharePolicy.friendlyMessage(APIError.Transport("timeout"), "Air"),
        )
        assertEquals(
            "Unlock this phone, then try sharing again.",
            SharePolicy.friendlyMessage(
                APIError.Transport("Unlock this phone, then try sharing again."),
                "Air",
            ),
        )
        assertEquals(
            "This saved connection is no longer available on this phone. Remove it and pair again.",
            SharePolicy.friendlyMessage(
                APIError.Transport(
                    "This saved connection is no longer available on this phone. Remove it and pair again.",
                ),
                "Air",
            ),
        )
        assertEquals(
            SharePolicy.generic(),
            SharePolicy.friendlyMessage(RuntimeException("/data/user/0/com.example/cache/secret.png"), "Air"),
        )
        assertTrue(SharePolicy.shouldPreservePreparedDelivery(APIError.Status(502)))
        assertFalse(SharePolicy.shouldPreservePreparedDelivery(APIError.BadUrl))
        assertTrue(SharePolicy.isImageSupportUnavailable(APIError.Status(404, "missing")))
    }

    private fun message(at: Double) = Message(
        id = "m$at",
        role = Message.Role.BOT,
        kind = Message.Kind.TEXT,
        at = at,
        text = "hi",
    )
}
