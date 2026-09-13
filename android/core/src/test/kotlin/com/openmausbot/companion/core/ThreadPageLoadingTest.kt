package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ThreadPageLoadingTest {
    private val bot = Bot("scout", "a", "Scout", "Research", "", true, "blue", false,
        ModelSelection("default", "default"), 1.0, tasks = listOf(BotTask("a", "A", 1.0), BotTask("b", "B", 2.0)))
    private val tail = Message("tail", Message.Role.USER, Message.Kind.TEXT, 2.0, text = "Recent")
    private val root = tail.copy(id = "root", at = 1.0, text = "Earlier")

    @Test
    fun liveMessageAndMetadataDoNotPretendAHistoryPageWasLoaded() {
        val state = CompanionState().apply(Frame.Message("b", tail)).apply(Frame.Bot(bot))
        assertFalse(state.hasLoadedPage("a"))
        assertFalse(state.hasLoadedPage("b"))
        val loaded = state.merge(ThreadPage(listOf(root, tail), hasMore = true), "b")
        assertEquals(listOf("root", "tail"), loaded.transcript("b").map { it.id })
        assertTrue(loaded.hasLoadedPage("b"))
        assertEquals(true, loaded.hasMore["b"])
    }

    @Test
    fun legacyFullPagesAndEmptyPagesCountAsLoadedAndKeepKnownPagination() {
        val loaded = CompanionState().merge(ThreadPage(emptyList()), "b")
        assertTrue(loaded.hasLoadedPage("b"))
        assertEquals(false, loaded.hasMore["b"])
        val more = loaded.merge(ThreadPage(listOf(tail), hasMore = true), "b")
            .merge(ThreadPage(listOf(root)), "b")
        assertEquals(true, more.hasMore["b"])
    }

    @Test
    fun hydrationAndNewOwnerFramesMarkOnlySuppliedPagesAsLoaded() {
        assertFalse(CompanionState().hydrate(Fleet(listOf(bot), emptyList())).hasLoadedPage("a"))
        assertTrue(CompanionState().hydrate(Fleet(listOf(bot.copy(messages = emptyList())), emptyList())).hasLoadedPage("a"))
        val state = CompanionState().apply(Frame.Message("a", tail))
            .apply(Frame.Bot(bot.copy(messages = listOf(root), hasMore = true)))
        assertTrue(state.hasLoadedPage("a"))
        assertEquals(listOf("root", "tail"), state.transcript("a").map { it.id })
    }

    @Test
    fun deletingABotClearsLoadedPagesAndBuffersForAllItsThreads() {
        val state = CompanionState(bots = listOf(bot), streaming = mapOf("b" to "Working"),
            reasoning = mapOf("b" to "Thinking"), activeLeafIds = mapOf("b" to "tail"))
            .merge(ThreadPage(listOf(root)), "a")
            .merge(ThreadPage(listOf(tail)), "b")
            .apply(Frame.BotDeleted(bot.id))
        assertFalse(state.hasLoadedPage("a"))
        assertFalse(state.hasLoadedPage("b"))
        assertTrue(state.messages.isEmpty())
        assertTrue(state.activeLeafIds.isEmpty())
        assertTrue(state.streaming.isEmpty())
        assertTrue(state.reasoning.isEmpty())
    }
}
