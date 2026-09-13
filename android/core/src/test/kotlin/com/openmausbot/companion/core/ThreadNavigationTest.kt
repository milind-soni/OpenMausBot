package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ThreadNavigationTest {
    private val bot = Bot(
        "scout", "current", "Scout", "Researcher", "", true, "blue", false,
        ModelSelection("default", "default"), 1.0,
    )
    private fun task(id: String, title: String = id, folder: String? = null) =
        BotTask(id, title, 1.0, projectId = folder)
    private val closer = ThreadCloser("helper", "Helper", 4.0)

    @Test
    fun savedFolderAndThreadOrderSurviveDuplicatesEmptyAndMissingFolders() {
        val folders = listOf(
            BotProject("second", "Second", "📚"), BotProject("first", "First"),
            BotProject("second", "Duplicate"), BotProject("empty", "Empty"),
        )
        val groups = bot.copy(
            projects = folders,
            tasks = listOf(task("first-thread", folder = "first"), task("s2", folder = "second"),
                task("missing", folder = "gone"), task("unfiled"), task("s1", folder = "second")),
        ).threadGroups()

        assertEquals(listOf("project:second", "project:first", "unfiled"), groups.map { it.id })
        assertEquals(listOf("s2", "s1"), groups[0].tasks.map { it.threadId })
        assertEquals("📚", groups[0].project?.emoji)
        assertEquals(listOf("missing", "unfiled"), groups[2].tasks.map { it.threadId })
    }

    @Test
    fun searchMatchesFolderNamesOrTrimmedThreadTitlesAndIncludesClosedThreads() {
        val grouped = bot.copy(
            projects = listOf(BotProject("research", "Research")),
            tasks = listOf(task("a", " Reading ", "research"),
                task("b", "Finished", "research").copy(closedBy = closer), task("blank", "  \n")),
        )
        assertEquals(listOf("a", "b"), grouped.threadGroups("  RESEARCH ").single().tasks.map { it.threadId })
        assertEquals(listOf("a"), grouped.threadGroups("reading").single().tasks.map { it.threadId })
        assertEquals(listOf("b"), grouped.threadGroups("finished").single().tasks.map { it.threadId })
        assertEquals("Untitled thread", grouped.threadGroups("untitled").single().tasks.single().displayTitle)
        assertTrue(grouped.threadGroups("nothing").isEmpty())
    }

    @Test
    fun closedThreadsRemainAccessibleWhenCurrentUnreadRunningWaitingOrManaging() {
        val closed = listOf("quiet", "current", "unread", "busy", "waiting", "queued").map {
            task(it).copy(closedBy = closer, unread = it == "unread", busy = it == "busy",
                activity = when (it) { "waiting" -> "waiting-on-you"; "queued" -> "queued"; else -> "idle" })
        }
        val grouped = bot.copy(tasks = closed + task("run").copy(routineRunId = "internal"))
        assertEquals(listOf("current", "unread", "busy", "waiting", "queued"),
            grouped.threadGroups().single().tasks.map { it.threadId })
        assertEquals(6, grouped.threadGroups(includingClosed = true).single().tasks.size)
        assertTrue(grouped.threadGroups("run").isEmpty())
        assertEquals("run", grouped.forTask("run")?.threadId)
    }

    @Test
    fun missingTaskMetadataHasALegacyConversationButAnExplicitEmptyListDoesNot() {
        val legacy = bot.copy(unread = true, busy = true)
        val thread = legacy.threadGroups().single().tasks.single()
        assertEquals("current", thread.threadId)
        assertEquals("Untitled thread", thread.displayTitle)
        assertTrue(thread.demandsAttention)
        assertTrue(bot.copy(tasks = emptyList()).threadGroups().isEmpty())
        assertTrue(bot.copy(tasks = listOf(task("run").copy(routineRunId = "internal"))).threadGroups().isEmpty())
    }

    @Test
    fun projectsDecodeWithoutChangingOlderPayloads() {
        val projects = CompanionJson.decodeFromString<BotProject>("""{"id":"p","name":"Plans"}""")
        assertNull(projects.emoji)
        assertEquals("p", projects.id)
        assertNull(bot.projects)
    }

    @Test
    fun summariesKeepSiblingIdentityRuntimeUnreadAndBranchPreviewsSeparate() {
        val left = task("a", "Alpha").copy(unread = true, busy = true, activity = "waiting-on-you")
        val right = task("b", "Beta").copy(unread = false, busy = false, activity = "idle")
        val root = Message("root", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "Question")
        val chosen = Message("chosen", Message.Role.BOT, Message.Kind.TEXT, 2.0, text = "Chosen", parentId = "root")
        val alternate = chosen.copy(id = "alternate", at = 3.0, text = "Other branch")
        val state = CompanionState(
            bots = listOf(bot.copy(threadId = "b", tasks = listOf(left, right), unread = true, busy = true)),
            messages = mapOf("a" to listOf(root, chosen, alternate), "b" to emptyList()),
            activeLeafIds = mapOf("a" to "chosen"),
        )
        val a = requireNotNull(state.chatSummary(ChatTarget.Bot("scout", "a")))
        val b = requireNotNull(state.chatSummary(ChatTarget.Bot("scout", "b")))
        assertNotEquals(a.conversationId, b.conversationId)
        assertEquals("bot:scout:a", a.conversationId)
        assertEquals("Alpha", a.chat.threadTitle)
        assertTrue(a.chat.busy)
        assertTrue(a.chat.unread)
        assertFalse(b.chat.busy)
        assertFalse(b.chat.unread)
        assertEquals("Chosen", a.preview)
        assertEquals(2.0, a.lastActivity)
        assertEquals("chosen", state.botForThread("a")?.activeLeafId)
        assertEquals("b", state.bot("scout")?.threadId)
    }

    @Test
    fun unreadBadgeCountsVisibleConversationsWithLegacyAggregateFallback() {
        val modern = bot.copy(unread = true, tasks = listOf(task("a").copy(unread = true),
            task("b").copy(unread = true), task("run").copy(unread = true, routineRunId = "internal")))
        assertEquals(2, CompanionState(bots = listOf(modern)).unreadCount)
        assertEquals(0, CompanionState(bots = listOf(modern.copy(hidden = true))).unreadCount)
        assertEquals(1, CompanionState(bots = listOf(bot.copy(unread = true))).unreadCount)
        assertEquals(1, CompanionState(bots = listOf(bot.copy(unread = true, tasks = listOf(task("a"))))).unreadCount)
        assertEquals(0, CompanionState(bots = listOf(bot.copy(unread = true, tasks = emptyList()))).unreadCount)
    }
}
