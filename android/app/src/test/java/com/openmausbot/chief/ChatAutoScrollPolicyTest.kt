package com.openmausbot.chief

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAutoScrollPolicyTest {
    @Test
    fun openingExistingChatStartsAtLatestMessage() {
        assertTrue(shouldFollowLatestMessage(previousCount = 0, currentCount = 12, isNearBottom = false))
    }

    @Test
    fun newReplyFollowsWhenReaderIsAlreadyNearBottom() {
        assertTrue(shouldFollowLatestMessage(previousCount = 12, currentCount = 13, isNearBottom = true))
    }

    @Test
    fun newReplyDoesNotStealPositionAfterReaderScrollsUp() {
        assertFalse(shouldFollowLatestMessage(previousCount = 12, currentCount = 13, isNearBottom = false))
    }

    @Test
    fun unchangedTranscriptDoesNotTriggerAnotherScroll() {
        assertFalse(shouldFollowLatestMessage(previousCount = 12, currentCount = 12, isNearBottom = true))
    }

    @Test
    fun readerCanJumpBackToLatestWheneverScrolledAway() {
        assertTrue(shouldShowJumpToLatest(messageCount = 12, isNearBottom = false))
        assertFalse(shouldShowJumpToLatest(messageCount = 12, isNearBottom = true))
        assertFalse(shouldShowJumpToLatest(messageCount = 0, isNearBottom = false))
    }
}
