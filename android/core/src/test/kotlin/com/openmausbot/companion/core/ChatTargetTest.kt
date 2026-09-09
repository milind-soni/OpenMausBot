package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class ChatTargetTest {
    @Test
    fun creatingElsewhereDoesNotChangeTheLocallySelectedTask() {
        val original = bot("b1", "task-1", "task-1")
        val target = Chat.BotChat(original).target
        val state = CompanionState(bots = listOf(original)).apply(
            Frame.Bot(bot("b1", "task-2", "task-1", "task-2")),
        )

        assertEquals("task-1", target.threadId)
        assertEquals("task-1", assertIs<Chat.BotChat>(state.chat(target)).threadId)
    }

    @Test
    fun switchingElsewhereDoesNotChangeTheLocallySelectedTask() {
        val original = bot("b1", "task-1", "task-1", "task-2")
        val target = Chat.BotChat(original).target
        val state = CompanionState(bots = listOf(original)).apply(
            Frame.Bot(bot("b1", "task-2", "task-1", "task-2")),
        )

        assertEquals("task-1", assertIs<Chat.BotChat>(state.chat(target)).threadId)
    }

    @Test
    fun deletingAnInactiveTaskKeepsTheActiveTask() {
        val original = bot("b1", "task-1", "task-1", "task-2")
        val target = Chat.BotChat(original).target
        val state = CompanionState(bots = listOf(original)).apply(
            Frame.Bot(bot("b1", "task-1", "task-1")),
        )

        assertEquals("task-1", assertIs<Chat.BotChat>(state.chat(target)).threadId)
    }

    @Test
    fun deletingTheLocallySelectedTaskClosesItWithoutChoosingASibling() {
        val original = bot("b1", "task-2", "task-1", "task-2")
        val target = Chat.BotChat(original).target
        val state = CompanionState(bots = listOf(original)).apply(
            Frame.Bot(bot("b1", "task-1", "task-1")),
        )

        assertEquals("task-2", target.threadId)
        assertNull(state.chat(target))
    }

    @Test
    fun removingTheBotClosesItsStableTarget() {
        val original = bot("b1", "task-1", "task-1")
        val target = Chat.BotChat(original).target
        val state = CompanionState(bots = listOf(original)).apply(Frame.BotDeleted("b1"))

        assertNull(state.chat(target))
    }

    @Test
    fun botTargetNeverChoosesAnotherBotWithTheSameRequestedThread() {
        val owner = bot("owner", "active-owner", "shared-thread", "active-owner")
        val other = bot("other", "active-other", "shared-thread", "active-other")
        val target = ChatTarget.Bot(owner.id, "shared-thread")
        val state = CompanionState(bots = listOf(other, owner))

        assertEquals("owner", assertIs<Chat.BotChat>(state.chat(target)).id)
    }

    @Test
    fun roomTargetUsesItsStableRoomId() {
        val owner = room("owner", "room-thread")
        val other = room("other", "room-thread")
        val target = Chat.RoomChat(owner).target
        val state = CompanionState(rooms = listOf(other, owner))

        assertEquals("owner", assertIs<Chat.RoomChat>(state.chat(target)).id)
    }

    private fun bot(id: String, active: String, vararg tasks: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
        tasks = tasks.mapIndexed { index, threadId ->
            BotTask(threadId, "Task ${index + 1}", index.toDouble())
        },
    )

    private fun room(id: String, threadId: String): Room = Room(
        id = id,
        threadId = threadId,
        name = id,
        memberIds = emptyList(),
        defaultResponder = GroupResponder("mentions"),
        bulletin = "",
        unread = false,
        createdAt = 1.0,
    )
}
