package com.astra.companion.ui

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp
import com.astra.companion.avatar.AvatarImageRules
import com.astra.companion.core.AvatarCrop
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * D2-05: what the single avatar renderer decides, pinned to
 * `ios/App/BotAvatarView.swift`.
 */
class BotAvatarRulesTest {

    @Test
    fun `each crop wears the mask the Swift gives it`() {
        assertEquals(CircleShape, BotAvatarRules.shape(AvatarCrop.CIRCLE, 52.dp))
        assertEquals(RectangleShape, BotAvatarRules.shape(AvatarCrop.SQUARE, 52.dp))
        assertEquals(RectangleShape, BotAvatarRules.shape(AvatarCrop.MASCOT, 52.dp))
    }

    @Test
    fun `the rounded mask's radius follows the size, at 22 percent`() {
        // `RoundedRectangle(cornerRadius: size * 0.22)`.
        assertEquals(RoundedCornerShape(11.44.dp), BotAvatarRules.shape(AvatarCrop.ROUNDED, 52.dp))
        assertEquals(RoundedCornerShape(24.64.dp), BotAvatarRules.shape(AvatarCrop.ROUNDED, 112.dp))
        assertEquals(0.22f, AvatarImageRules.ROUNDED_CORNER_FRACTION)
    }

    @Test
    fun `the fetch key changes when either the attachment or the crop does`() {
        val a = BotAvatarRules.identity("/api/attachments/a.png", AvatarCrop.CIRCLE)

        assertNotEquals(a, BotAvatarRules.identity("/api/attachments/b.png", AvatarCrop.CIRCLE))
        assertNotEquals(a, BotAvatarRules.identity("/api/attachments/a.png", AvatarCrop.ROUNDED))
        assertEquals(a, BotAvatarRules.identity("/api/attachments/a.png", AvatarCrop.CIRCLE))
    }

    @Test
    fun `a bot with no attachment still has a stable key`() {
        assertEquals("|mascot", BotAvatarRules.identity(null, AvatarCrop.MASCOT))
        assertEquals("|circle", BotAvatarRules.identity(null, AvatarCrop.CIRCLE))
    }

    @Test
    fun `every failure lands on the mascot`() {
        val path = "/api/attachments/a.png"

        // `crop != .mascot && bot.avatarUrl != nil && !failed`.
        assertTrue(AvatarImageRules.usesImage(AvatarCrop.CIRCLE, path, failed = false))
        assertFalse(
            AvatarImageRules.usesImage(AvatarCrop.MASCOT, path, failed = false),
            "the mascot crop ignores a stored attachment",
        )
        assertFalse(
            AvatarImageRules.usesImage(AvatarCrop.CIRCLE, null, failed = false),
            "a crop without an attachment has nothing to paint",
        )
        assertFalse(
            AvatarImageRules.usesImage(AvatarCrop.CIRCLE, path, failed = true),
            "a fetch or decode that failed falls back deterministically",
        )
    }
}
