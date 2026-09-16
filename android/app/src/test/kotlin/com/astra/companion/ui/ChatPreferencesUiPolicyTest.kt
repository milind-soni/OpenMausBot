package com.astra.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class ChatPreferencesUiPolicyTest {
    @Test
    fun `empty quick reply list hides predictive chips without hiding slash hud`() {
        assertEquals(
            ComposerAccessory.NONE,
            ComposerAccessories.accessory(
                hudOpen = false,
                draft = "",
                busy = false,
                pendingApproval = false,
                hasQuickReplies = false,
                hasAttachments = false,
            ),
        )
        assertEquals(
            ComposerAccessory.HUD,
            ComposerAccessories.accessory(
                hudOpen = true,
                draft = "",
                busy = false,
                pendingApproval = false,
                hasQuickReplies = false,
                hasAttachments = false,
            ),
        )
    }
}
