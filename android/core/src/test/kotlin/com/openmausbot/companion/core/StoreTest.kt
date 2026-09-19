package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StoreTest {
    private fun fleet(): Fleet = decodeFixture("bots-paged")
    private fun message(id: String, at: Double = 1.0, text: String = "hello") = Message(
        id = id,
        role = Message.Role.USER,
        kind = Message.Kind.TEXT,
        at = at,
        text = text,
    )
    private fun hydrated(): CompanionState = CompanionState().hydrate(fleet())

    @Test
    fun hydrateIndexesEveryThread() {
        val state = hydrated()
        assertTrue(state.bots.isNotEmpty())
        state.bots.forEach { assertNotNull(state.messages[it.threadId]) }
        state.rooms.forEach {
            assertEquals(it.messages?.size, state.transcript(it.threadId).size)
            assertEquals(it.hasMore, state.hasMore[it.threadId])
        }
    }

    @Test
    fun sidebarSectionsGroupBotsAndChannelsInNaturalOrder() {
        val source = fleet()
        val base = source.bots.first()
        val researchBot = base.copy(id = "research-1", threadId = "research-t1", section = "Research")
        val personalBot = base.copy(id = "personal-1", threadId = "personal-t1", section = "Personal")
        val pinnedResearch = base.copy(
            id = "pinned-research",
            threadId = "pinned-research-t",
            section = "Research",
            pinned = true,
        )
        val researchChief = base.copy(
            id = "research-chief",
            threadId = "research-chief-t",
            section = "Research",
            chiefOfStaff = true,
            pinned = true,
        )
        val unsectionedChief = base.copy(
            id = "default-chief",
            threadId = "default-chief-t",
            chiefOfStaff = true,
        )
        val hidden = base.copy(id = "hidden", threadId = "hidden-t", section = "Secret", hidden = true)
        val baseRoom = source.groups.first()
        val researchChannel = baseRoom.copy(id = "research-channel", section = "Research")
        val generalChannel = baseRoom.copy(id = "general-channel", section = "  ")
        val directChat = baseRoom.copy(id = "direct-chat", dm = true)
        val state = CompanionState(
            bots = listOf(researchChief, researchBot, personalBot, pinnedResearch, unsectionedChief, hidden),
            rooms = listOf(generalChannel, researchChannel, directChat),
        )

        assertEquals(listOf("Research", "Personal"), state.sidebarSections.map(SidebarSection::name))
        assertEquals(listOf("research-chief"), state.sidebarSections[0].chiefs.map(Bot::id))
        assertEquals(listOf("research-1"), state.sidebarSections[0].bots.map(Bot::id))
        assertEquals(listOf("research-channel"), state.sidebarSections[0].channels.map(Room::id))
        assertEquals("default-chief", state.unsectionedChief?.id)
        assertEquals(emptyList(), state.unsectionedBots)
        assertEquals(listOf("pinned-research"), state.pinnedBots.map(Bot::id))
        assertEquals(listOf("general-channel"), state.unsectionedChannels.map(Room::id))
        assertEquals(listOf("direct-chat"), state.botChats.map(Room::id))
    }

    @Test
    fun applyIsPureAndLeavesThePreviousStateUntouched() {
        val before = hydrated()
        val threadId = before.bots.first().threadId
        val after = before.apply(Frame.Message(threadId, message("new")))
        assertFalse(before.transcript(threadId).any { it.id == "new" })
        assertTrue(after.transcript(threadId).any { it.id == "new" })
    }

    @Test
    fun appendsAndPatchesInPlace() {
        var state = hydrated()
        val threadId = state.bots.first().threadId
        val before = state.transcript(threadId).size
        state = state.apply(Frame.Message(threadId, message("new-1")))
        assertEquals(before + 1, state.transcript(threadId).size)
        state = state.apply(Frame.MessagePatch(threadId, message("new-1", text = "edited")))
        assertEquals(before + 1, state.transcript(threadId).size)
        assertEquals("edited", state.transcript(threadId).last().text)
    }

    @Test
    fun patchForAnUnseenMessageAppendsIt() {
        val state = CompanionState().apply(Frame.MessagePatch("t1", message("missed")))
        assertEquals(listOf("missed"), state.transcript("t1").map(Message::id))
    }

    @Test
    fun replayedMessageDoesNotAppearTwice() {
        var state = hydrated()
        val threadId = state.bots.first().threadId
        val before = state.transcript(threadId).size
        state = state.apply(Frame.Message(threadId, message("dupe")))
        state = state.apply(Frame.Message(threadId, message("dupe")))
        assertEquals(before + 1, state.transcript(threadId).size)
    }

    @Test
    fun scrollbackPrependsWithoutDuplicating() {
        val state = CompanionState(messages = mapOf("t1" to listOf(message("c"), message("d"))))
            .prepend(ThreadPage(listOf(message("a"), message("b"), message("c")), true), "t1")
        assertEquals(listOf("a", "b", "c", "d"), state.transcript("t1").map(Message::id))
        assertEquals(true, state.hasMore["t1"])
    }

    @Test
    fun searchWindowMergesAndOrdersWithoutDuplicating() {
        val state = CompanionState(messages = mapOf(
            "t1" to listOf(message("d", 4.0), message("e", 5.0)),
        )).merge(
            ThreadPage(listOf(message("b", 2.0), message("c", 3.0), message("d", 4.0)), true),
            "t1",
        )
        assertEquals(listOf("b", "c", "d", "e"), state.transcript("t1").map(Message::id))
        assertEquals(true, state.hasMore["t1"])
    }

    @Test
    fun botFrameMergesRatherThanWipingTranscript() {
        var state = hydrated()
        val bot = state.bots.first()
        state = state.apply(Frame.Message(bot.threadId, message("keep-me")))
        val count = state.transcript(bot.threadId).size
        state = state.apply(Frame.Bot(bot.copy(messages = null, busy = true, unread = true)))
        assertEquals(true, state.bot(bot.id)?.busy)
        assertEquals(count, state.transcript(bot.threadId).size)
        assertNotNull(state.bot(bot.id)?.messages)
    }

    @Test
    fun taskSwitchReplacesTheActiveTranscript() {
        var state = hydrated()
        val bot = state.bots.first()
        state = state.apply(Frame.Message(bot.threadId, message("old-tail")))
        state = state.apply(Frame.Bot(bot.copy(
            threadId = "another-task",
            messages = listOf(message("new-root", text = "new task")),
            activeLeafId = "new-root",
        )))
        assertEquals("another-task", state.bot(bot.id)?.threadId)
        assertEquals(listOf("new-root"), state.transcript("another-task").map(Message::id))
        assertFalse(state.transcript("another-task").any { it.id == "old-tail" })
    }

    @Test
    fun roomFrameNeverWipesTranscript() {
        val hydrated = hydrated()
        val room = hydrated.rooms.first()
        val existing = hydrated.transcript(room.threadId)
        val state = hydrated.apply(Frame.Room(room.copy(messages = null, unread = true)))
        assertEquals(existing, state.transcript(room.threadId))
        assertEquals(true, state.roomForThread(room.threadId)?.unread)
    }

    @Test
    fun roomTaskSwitchReplacesTheActiveTranscript() {
        var state = hydrated()
        val room = state.rooms.first()
        state = state.apply(Frame.Message(room.threadId, message("old-tail")))
        state = state.apply(Frame.Room(room.copy(
            threadId = "another-room-task",
            tasks = listOf(BotTask("another-room-task", "Fresh", 2.0)),
            messages = listOf(message("new-root", text = "new room task")),
            hasMore = true,
        )))
        assertEquals("another-room-task", state.rooms.first { it.id == room.id }.threadId)
        assertEquals(listOf("new-root"), state.transcript("another-room-task").map(Message::id))
        assertEquals(true, state.hasMore["another-room-task"])
        assertFalse(state.transcript("another-room-task").any { it.id == "old-tail" })
    }

    @Test
    fun visibleTranscriptFollowsTheActiveBranch() {
        val hydrated = hydrated()
        val bot = hydrated.bots.first()
        val root = message("root")
        val first = message("first", 2.0).copy(parentId = root.id)
        val fork = message("fork", 3.0).copy(parentId = root.id)
        val tail = message("tail", 4.0).copy(parentId = fork.id)
        val state = hydrated.copy(messages = hydrated.messages + (bot.threadId to listOf(root, first, fork, tail)))
            .apply(Frame.Thread(bot.threadId, tail.id))
        assertEquals(listOf("root", "fork", "tail"), state.visibleTranscript(bot.threadId).map(Message::id))
    }

    /** root → question → old answer, with the old answer visible. */
    private fun editableConversation(): Pair<CompanionState, String> {
        val hydrated = hydrated()
        val threadId = hydrated.bots.first().threadId
        val root = message("root", 1.0, "Ready").copy(role = Message.Role.BOT)
        val question = message("q1", 2.0, "first try").copy(parentId = root.id)
        val answer = message("a1", 3.0, "old answer").copy(role = Message.Role.BOT, parentId = question.id)
        val state = hydrated.copy(messages = hydrated.messages + (threadId to listOf(root, question, answer)))
            .apply(Frame.Thread(threadId, answer.id))
        return state to threadId
    }

    @Test
    fun pendingEditReplacesTheQuestionAndHidesTheOldAnswerAtOnce() {
        val (base, threadId) = editableConversation()
        val pending = PendingEdit("q1", "second try", 4.0)
        val state = base.copy(pendingEdits = mapOf(threadId to pending))
        val visible = state.visibleTranscript(threadId)
        assertEquals(listOf("root", pending.placeholderId), visible.map(Message::id))
        assertEquals("second try", visible.last().text)
        assertEquals("root", visible.last().parentId)
        // nothing was folded: the computer's transcript is untouched
        assertEquals(listOf("root", "q1", "a1"), state.transcript(threadId).map(Message::id))
        // a failed edit only drops the stand-in, so the old branch returns
        assertEquals(listOf("root", "q1", "a1"), state.copy(pendingEdits = emptyMap()).visibleTranscript(threadId).map(Message::id))
    }

    @Test
    fun streamedForkTakesOverFromThePendingEdit() {
        val (base, threadId) = editableConversation()
        val fork = message("q2", 4.0, "second try").copy(parentId = "root")
        val state = base.copy(pendingEdits = mapOf(threadId to PendingEdit("q1", "second try", 4.0)))
            // the message frame alone is a sibling, not a child of the leaf...
            .apply(Frame.Message(threadId, fork))
            // ...and the leaf frame moves the branch, which retires the stand-in
            .apply(Frame.Thread(threadId, fork.id))
        assertEquals(listOf("root", "q2"), state.visibleTranscript(threadId).map(Message::id))
    }

    @Test
    fun adoptEditShowsTheForkWhenTheResponseBeatsTheStream() {
        val (base, threadId) = editableConversation()
        val fork = message("q2", 4.0, "second try").copy(parentId = "root")
        assertEquals(listOf("root", "q2"), base.adoptEdit(fork, threadId).visibleTranscript(threadId).map(Message::id))
    }

    @Test
    fun adoptEditNeverHidesAReplyThatAlreadyArrived() {
        val (base, threadId) = editableConversation()
        val fork = message("q2", 4.0, "second try").copy(parentId = "root")
        val reply = message("a2", 5.0, "new answer").copy(role = Message.Role.BOT, parentId = fork.id)
        val state = base.apply(Frame.Message(threadId, fork))
            .apply(Frame.Thread(threadId, fork.id))
            .apply(Frame.Message(threadId, reply))
            .adoptEdit(fork, threadId)
        assertEquals(listOf("root", "q2", "a2"), state.visibleTranscript(threadId).map(Message::id))
    }

    @Test
    fun versionsAreUserMessagesWithTheSameParent() {
        val root = message("root")
        val first = message("first", 2.0).copy(parentId = root.id)
        val second = message("second", 3.0).copy(parentId = root.id)
        val reply = message("reply", 4.0).copy(role = Message.Role.BOT, parentId = root.id)
        val state = CompanionState(messages = mapOf("t1" to listOf(root, second, reply, first)))
        assertEquals(listOf("first", "second"), state.versions(first, "t1").map(Message::id))
    }

    @Test
    fun messageAppendMovesLeafAndBranchSwitchClearsLiveText() {
        var state = hydrated()
        val bot = state.bots.first()
        state = state.apply(Frame.Runtime(RuntimeEvent(
            "content.delta", bot.threadId, "old branch", "assistant_text",
        )))
        state = state.apply(Frame.Thread(bot.threadId, "other"))
        assertNull(state.streaming[bot.threadId])
        state = state.apply(Frame.Message(bot.threadId, message("latest").copy(parentId = "other")))
        assertEquals("latest", state.bot(bot.id)?.activeLeafId)
    }

    @Test
    fun lateArtifactDoesNotReplaceTheActiveLeaf() {
        val hydrated = hydrated()
        val bot = hydrated.bots.first()
        val root = message("turn-done")
        val followUp = message("follow-up", at = 2.0).copy(parentId = root.id)
        val state = hydrated.copy(
            messages = hydrated.messages + (bot.threadId to listOf(root, followUp)),
        ).apply(Frame.Thread(bot.threadId, followUp.id)).apply(
            Frame.Message(
                bot.threadId,
                message("late-screen", at = 3.0).copy(
                    role = Message.Role.BOT,
                    kind = Message.Kind.SCREEN,
                    parentId = root.id,
                ),
            ),
        )

        assertEquals(followUp.id, state.bot(bot.id)?.activeLeafId)
        assertEquals(listOf(root.id, followUp.id), state.visibleTranscript(bot.threadId).map(Message::id))
        assertTrue(state.transcript(bot.threadId).any { it.id == "late-screen" })
    }

    @Test
    fun deletingABotDropsTranscriptStreamAndScreen() {
        var state = hydrated()
        val bot = state.bots.first()
        state = state.apply(Frame.Runtime(RuntimeEvent(
            "content.delta", bot.threadId, "partial", "assistant_text",
        )))
        state = state.apply(Frame.Screen(bot.id, "AAAA", "image/png"))
        state = state.apply(Frame.BotDeleted(bot.id))
        assertNull(state.bot(bot.id))
        assertTrue(state.transcript(bot.threadId).isEmpty())
        assertNull(state.hasMore[bot.threadId])
        assertNull(state.streaming[bot.threadId])
        assertNull(state.screens[bot.id])
    }

    @Test
    fun deletingARoomDropsTranscriptAndStream() {
        var state = hydrated()
        val room = state.rooms.first()
        state = state.apply(Frame.Runtime(RuntimeEvent(
            "content.delta", room.threadId, "partial", "assistant_text",
        )))
        state = state.apply(Frame.RoomDeleted(room.id))
        assertNull(state.roomForThread(room.threadId))
        assertTrue(state.transcript(room.threadId).isEmpty())
        assertNull(state.hasMore[room.threadId])
        assertNull(state.streaming[room.threadId])
    }

    @Test
    fun unknownBotFrameAddsIt() {
        val bot = hydrated().bots.first().copy(id = "brand-new", threadId = "brand-new-thread")
        val state = CompanionState().apply(Frame.Bot(bot))
        assertEquals(1, state.bots.size)
        assertNotNull(state.messages["brand-new-thread"])
    }

    @Test
    fun pendingApprovalsAreUnansweredOnesNewestFirst() {
        val hydrated = hydrated()
        val firstThread = hydrated.bots.first().threadId
        val secondThread = hydrated.rooms.first().threadId
        fun card(id: String, at: Double, requestId: String?, answered: String? = null) = Message(
            id = id,
            role = Message.Role.BOT,
            kind = Message.Kind.OPTIONS,
            at = at,
            card = OptionCard(
                title = "Approval needed",
                subtitle = "rm -rf ./build",
                options = listOf("Allow", "Deny"),
                answered = answered,
                requestId = requestId,
                tool = "Bash",
                allowKey = "Bash:rm",
            ),
        )
        val state = hydrated.copy(messages = hydrated.messages + mapOf(
            firstThread to listOf(
                card("old", 1.0, "r1"),
                card("answered", 2.0, "r2", "Allow"),
                card("history", 3.0, null),
            ),
            secondThread to listOf(card("new", 9.0, "r3")),
        ))
        assertEquals(listOf("new", "old"), state.pendingApprovals.map { it.message.id })
        assertEquals(secondThread, state.pendingApprovals.first().threadId)
    }

    @Test
    fun unreadCountCountsVisibleUnreadBotsAndUnreadRooms() {
        val hydrated = hydrated()
        val visibleUnread = hydrated.bots.first().copy(unread = true, hidden = false)
        val hiddenUnread = visibleUnread.copy(id = "hidden", threadId = "hidden-thread", hidden = true)
        val read = visibleUnread.copy(id = "read", threadId = "read-thread", unread = false)
        val unreadRoom = hydrated.rooms.first().copy(unread = true)
        assertEquals(
            2,
            hydrated.copy(bots = listOf(visibleUnread, hiddenUnread, read), rooms = listOf(unreadRoom)).unreadCount,
        )
    }

    @Test
    fun cursorFollowsStreamAndKeepsStreamId() {
        var state = CompanionState().apply(Frame.Hello("abc12345:7", true))
        assertNull(state.cursor)
        state = state.resetCursor("abc12345:7")
        assertEquals("abc12345:7", state.cursor)
        state = state.advance(8)
        assertEquals("abc12345:8", state.cursor)
        state = state.advance(null)
        assertEquals("abc12345:8", state.cursor)
    }

    @Test
    fun advancingBeforeAnyHelloDoesNothing() {
        assertNull(CompanionState().advance(4).cursor)
    }

    @Test
    fun notificationsCollectInOrder() {
        val approval = NotificationFrame(
            "approval", "b1", "Scout", "t1", "Scout needs approval", "rm -rf",
        )
        val done = NotificationFrame("done", "b1", "Scout", "t1", "Scout finished", "pushed")
        val state = CompanionState().apply(Frame.Notify(approval)).apply(Frame.Notify(done))
        assertEquals(2, state.notifications.size)
        assertTrue(state.notifications[0].isBlocking)
        assertFalse(state.notifications[1].isBlocking)
    }

    @Test
    fun notificationsKeepOnlyARecentWindow() {
        var state = CompanionState()
        repeat(120) { index ->
            state = state.apply(Frame.Notify(NotificationFrame(
                "done", "b1", "Scout", "t1", "Done $index", "body",
            )))
        }
        assertEquals(100, state.notifications.size)
        assertEquals("Done 20", state.notifications.first().title)
    }

    @Test
    fun framesThisClientIgnoresAreHarmless() {
        var state = hydrated()
        val before = state.bots.size
        state = state.apply(Frame.Screen("b1", "AAAA", "image/png"))
        state = state.apply(Frame.Computer("b1", "provisioning"))
        state = state.apply(Frame.Config)
        state = state.apply(Frame.Runtime(RuntimeEvent("content.delta", "t1", "hi", "assistant_text")))
        state = state.apply(Frame.Unknown("routine.run"))
        assertEquals(before, state.bots.size)
    }
}

class StreamingTest {
    private fun delta(text: String, thread: String = "t1", kind: String = "assistant_text") =
        Frame.Runtime(RuntimeEvent("content.delta", thread, text, kind))

    @Test
    fun deltasAccumulateIntoLiveText() {
        val state = CompanionState().apply(delta("Hel")).apply(delta("lo, ")).apply(delta("world"))
        assertEquals("Hello, world", state.streaming["t1"])
    }

    @Test
    fun reasoningIsKeptApartFromAnswer() {
        val state = CompanionState().apply(delta("thinking…", kind = "reasoning_text")).apply(delta("the answer"))
        assertEquals("thinking…", state.reasoning["t1"])
        assertEquals("the answer", state.streaming["t1"])
    }

    @Test
    fun unknownStreamKindIsDroppedRatherThanGuessedAt() {
        val state = CompanionState().apply(delta("???", kind = "some_future_kind"))
        assertNull(state.streaming["t1"])
        assertNull(state.reasoning["t1"])
    }

    @Test
    fun settledReplyReplacesLiveText() {
        var state = CompanionState().apply(delta("partial answer"))
        assertNotNull(state.streaming["t1"])
        state = state.apply(Frame.Message("t1", Message(
            "m1", Message.Role.BOT, Message.Kind.TEXT, 1.0, "partial answer, completed",
        )))
        assertNull(state.streaming["t1"])
        assertEquals(1, state.transcript("t1").size)
    }

    @Test
    fun onlySettledBotTextReplyClearsIt() {
        var state = CompanionState().apply(delta("mid-answer"))
        state = state.apply(Frame.Message("t1", Message(
            "u1", Message.Role.USER, Message.Kind.TEXT, 1.0, "another question",
        )))
        state = state.apply(Frame.Message("t1", Message(
            "a1", Message.Role.BOT, Message.Kind.ACTIVITY, 2.0,
        )))
        assertEquals("mid-answer", state.streaming["t1"])
    }

    @Test
    fun turnEndingClearsEvenWithoutSettledMessage() {
        listOf("turn.completed", "turn.failed", "turn.aborted").forEach { ending ->
            val state = CompanionState().apply(delta("half a sentence")).apply(
                Frame.Runtime(RuntimeEvent(ending, "t1")),
            )
            assertNull(state.streaming["t1"], "$ending should end the live bubble")
            assertNull(state.reasoning["t1"])
        }
    }

    @Test
    fun threadsStreamIndependently() {
        val state = CompanionState()
            .apply(delta("for one", "t1"))
            .apply(delta("for two", "t2"))
            .apply(Frame.Runtime(RuntimeEvent("turn.completed", "t1")))
        assertNull(state.streaming["t1"])
        assertEquals("for two", state.streaming["t2"])
    }
}

class ScreenTest {
    private fun frame(png: String, bot: String = "b1") = Frame.Screen(bot, png, "image/png")

    @Test
    fun onlyNewestFrameIsKept() {
        val state = CompanionState().apply(frame("AAAA")).apply(frame("BBBB")).apply(frame("CCCC"))
        assertEquals("CCCC", state.screens["b1"]?.png)
        assertEquals(1, state.screens.size)
    }

    @Test
    fun botsAreTrackedSeparately() {
        val state = CompanionState().apply(frame("one", "b1")).apply(frame("two", "b2"))
        assertEquals("one", state.screens["b1"]?.png)
        assertEquals("two", state.screens["b2"]?.png)
    }

    @Test
    fun closingPanelForgetsFrame() {
        val state = CompanionState().apply(frame("stale")).clearScreen("b1")
        assertNull(state.screens["b1"])
    }

    @Test
    fun badBase64DecodesToNullRatherThanCrashing() {
        assertContentEquals("hello".toByteArray(), ScreenFrame("aGVsbG8=", "image/png").data)
        assertNull(ScreenFrame("not base64 at all!!", "image/png").data)
    }
}
