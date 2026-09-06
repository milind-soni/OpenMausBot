package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatTarget
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NavigationTest {
    private val botChat = Destination.Chat(ChatTarget.Bot("bot-1", "thread-1"))

    @Test
    fun `the roster is the floor of the stack`() {
        val navigator = CompanionNavigator()
        assertEquals(Destination.Roster, navigator.current)
        assertFalse(navigator.canGoBack)
        navigator.pop()
        assertEquals(Destination.Roster, navigator.current)
    }

    @Test
    fun `pushing and popping walks the stack`() {
        val navigator = CompanionNavigator()
        navigator.push(botChat)
        assertTrue(navigator.canGoBack)
        assertEquals(botChat, navigator.current)
        navigator.pop()
        assertEquals(Destination.Roster, navigator.current)
    }

    @Test
    fun `pushing the destination already on top is a no-op`() {
        val navigator = CompanionNavigator()
        navigator.push(botChat)
        navigator.push(botChat)
        assertEquals(2, navigator.stack.size)
    }

    @Test
    fun `opening a chat addresses it by its owner`() {
        val navigator = CompanionNavigator()
        navigator.open(Chat.BotChat(bot(id = "bot-9")))
        navigator.open(Chat.RoomChat(room(id = "room-9")))

        assertEquals(
            listOf(
                Destination.Roster,
                Destination.Chat(ChatTarget.Bot("bot-9", "thread-bot-9")),
                Destination.Chat(ChatTarget.Room("room-9", "thread-room-9")),
            ),
            navigator.stack,
        )
    }

    @Test
    fun `a resolved notification thread is re-addressed in place`() {
        val navigator = CompanionNavigator()
        navigator.openThread("task-2")
        navigator.resolveThread("task-2", ChatTarget.Bot("bot-1", "task-2"))

        assertEquals(
            listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("bot-1", "task-2"))),
            navigator.stack,
        )
        // Back still leads where it did before the address changed.
        navigator.pop()
        assertEquals(Destination.Roster, navigator.current)
    }

    @Test
    fun `resolving a thread the reader already left changes nothing`() {
        val navigator = CompanionNavigator()
        navigator.openThread("task-2")
        navigator.pop()
        navigator.resolveThread("task-2", ChatTarget.Bot("bot-1", "task-2"))
        assertEquals(listOf(Destination.Roster), navigator.stack)
    }

    @Test
    fun `a notification tap lands on the thread with the roster behind it`() {
        val navigator = CompanionNavigator()
        navigator.push(Destination.Settings)
        navigator.openThread("t9")
        assertEquals(listOf(Destination.Roster, Destination.Thread("t9")), navigator.stack)
        navigator.pop()
        assertEquals(Destination.Roster, navigator.current)
    }

    @Test
    fun `a resolved notification chat lands with the roster behind it`() {
        val navigator = CompanionNavigator()
        navigator.push(Destination.Settings)
        navigator.openFromNotification(Chat.BotChat(bot(id = "bot-1").copy(threadId = "task-2")))
        assertEquals(
            listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("bot-1", "task-2"))),
            navigator.stack,
        )
        navigator.pop()
        assertEquals(Destination.Roster, navigator.current)
    }

    @Test
    fun `the stack survives a round trip through the saver`() {
        val stack = listOf(
            Destination.Roster,
            Destination.Settings,
            Destination.Routines,
            Destination.ConnectedApps,
            Destination.Thread("thread:with:colons"),
            Destination.Computer("bot:with:colons"),
            Destination.Overview("bot:with:colons"),
            Destination.Chat(ChatTarget.Bot("bot:1:x", "thread:1:y")),
            Destination.Chat(ChatTarget.Room("room::9", "")),
        )
        assertEquals(stack, CompanionNavigator.decode(CompanionNavigator.encode(stack)))
    }

    @Test
    fun `a bonded save from a previous generation is rejected on restore`() {
        val stack = listOf(
            Destination.Roster,
            Destination.Chat(ChatTarget.Bot("old-bot", "old-task")),
        )
        val saved = CompanionNavigator.encodeWithBond(stack, bondGeneration = 0)
        assertNull(CompanionNavigator.restoreForGeneration(saved, expectedGeneration = 1))
        assertEquals(
            stack,
            requireNotNull(CompanionNavigator.restoreForGeneration(saved, expectedGeneration = 0)).stack,
        )
        // A pre-bond encoding (no generation marker) cannot restore into a later bond.
        assertNull(
            CompanionNavigator.restoreForGeneration(
                CompanionNavigator.encode(stack),
                expectedGeneration = 0,
            ),
        )
    }

    @Test
    fun `a receipt's task opens above Tasks and Routines, and back returns there`() {
        // iOS appends the chat to the same navigation path Settings →
        // TasksRoutinesView is on, so leaving it lands back on the receipts.
        val navigator = CompanionNavigator()
        navigator.push(Destination.Settings)
        navigator.push(Destination.Routines)
        navigator.push(botChat)
        assertEquals(botChat, navigator.current)
        navigator.pop()
        assertEquals(Destination.Routines, navigator.current)
        navigator.pop()
        assertEquals(Destination.Settings, navigator.current)
    }

    @Test
    fun `an overview round-trips through encode and decode`() {
        val destination = Destination.Overview("bot-1")
        assertEquals(
            listOf(destination),
            CompanionNavigator.decode(CompanionNavigator.encode(listOf(destination))),
        )
    }

    @Test
    fun `a computer sits above the chat it was opened from`() {
        val navigator = CompanionNavigator()
        navigator.push(botChat)
        navigator.push(Destination.Computer("bot-1"))
        assertEquals(Destination.Computer("bot-1"), navigator.current)
        navigator.pop()
        assertEquals(botChat, navigator.current)
    }

    @Test
    fun `retainsChatDraft is true under Computer and false after pop to roster`() {
        val navigator = CompanionNavigator()
        navigator.push(botChat)
        assertTrue(navigator.retainsChatDraft("bot-1"))
        assertFalse(navigator.retainsChatDraft("bot-other"))

        navigator.push(Destination.Computer("bot-1"))
        assertTrue(
            navigator.retainsChatDraft("bot-1"),
            "Computer push must keep the chat on the stack so the draft holder survives",
        )

        navigator.pop()
        navigator.pop()
        assertFalse(
            navigator.retainsChatDraft("bot-1"),
            "Roster pop must drop the chat so dispose clears the holder",
        )
    }

    @Test
    fun `the five addressable destinations do not collide in saved state`() {
        val encoded = CompanionNavigator.encode(
            listOf(
                Destination.Thread("x"),
                Destination.Computer("x"),
                Destination.Overview("x"),
                Destination.Chat(ChatTarget.Bot("x", "x")),
                Destination.Chat(ChatTarget.Room("x", "x")),
            ),
        )
        assertEquals(encoded.size, encoded.toSet().size, "encodings must be distinguishable")
    }

    @Test
    fun `a chat entry that cannot be read back is dropped rather than crashing`() {
        // Truncated, malformed and over-long length prefixes all mean "unreadable".
        assertEquals(
            listOf(Destination.Roster),
            CompanionNavigator.decode(
                listOf("roster", "botchat:", "botchat:x:abc", "roomchat:99:abc"),
            ),
        )
    }

    @Test
    fun `an unreadable saved entry is dropped rather than crashing`() {
        assertEquals(
            listOf(Destination.Roster, Destination.Settings),
            CompanionNavigator.decode(listOf("roster", "nonsense", "settings")),
        )
    }

    @Test
    fun `an empty restore still lands on the roster`() {
        assertEquals(listOf(Destination.Roster), CompanionNavigator(emptyList()).stack)
    }
}

/**
 * The notification tap has to fire once and only once — and "once" has to
 * survive a configuration change, because a rotation during the cold-start
 * restore is exactly when the tap is slowest to be consumed.
 *
 * Expectations come from `_temp/PARITY_DELTA_AUDIT_2.md` §D2-03 and from
 * iOS carrying both ids (`Notifications.swift:35-38`, `Models.swift:624-643`):
 * the composite `(botId, threadId)` is what is offered, consumed, and
 * remembered across recreation — never a bare thread.
 */
class PendingThreadNavigationTest {

    @Test
    fun `a tap is offered to the UI as a notification target`() {
        val navigation = PendingThreadNavigation()
        navigation.offer("bot-1", "t1")
        assertEquals(target("bot-1", "t1"), navigation.pending.value)
    }

    @Test
    fun `an absent or blank extra offers nothing`() {
        val navigation = PendingThreadNavigation()
        navigation.offer(null, "t1")
        navigation.offer("bot-1", null)
        navigation.offer("bot-1", "")
        navigation.offer(" ", "t1")
        navigation.offer(null as String?, null as String?)
        assertNull(navigation.pending.value)
    }

    @Test
    fun `a rotation before the UI consumed it still navigates`() {
        val launch = PendingThreadNavigation()
        launch.offer("bot-1", "t1")
        // Recreated without the UI ever consuming: the token is still null.
        val recreated = PendingThreadNavigation(launch.consumedToken())
        recreated.offer("bot-1", "t1")
        assertEquals(target("bot-1", "t1"), recreated.pending.value)
    }

    @Test
    fun `a rotation after the UI consumed it does not navigate again`() {
        val launch = PendingThreadNavigation()
        launch.offer("bot-1", "t1")
        launch.consume()
        assertNull(launch.pending.value)

        val recreated = PendingThreadNavigation(launch.consumedToken())
        recreated.offer("bot-1", "t1")
        assertNull(recreated.pending.value)
    }

    @Test
    fun `two notifications in a row for the same thread navigate again while the app is up`() {
        val navigation = PendingThreadNavigation()
        navigation.offer("bot-1", "t1")
        navigation.consume()
        navigation.offer("bot-1", "t1", fresh = true)
        assertEquals(target("bot-1", "t1"), navigation.pending.value)
    }

    @Test
    fun `a different target always navigates`() {
        val navigation = PendingThreadNavigation()
        navigation.offer("bot-1", "t1")
        navigation.consume()
        navigation.offer("bot-1", "t2")
        assertEquals(target("bot-1", "t2"), navigation.pending.value)
    }

    @Test
    fun `the consumed token round-trips bot and thread including colons`() {
        val target = target("bot:1:x", "thread:2:y")
        val token = PendingThreadNavigation.tokenOf(target)
        assertEquals(target, PendingThreadNavigation.parseToken(token))
    }

    private fun target(botId: String, threadId: String) =
        requireNotNull(com.openmausbot.companion.core.NotificationTarget.from(botId, threadId))
}

/**
 * The camera can only be released by the screen that opened it, and the provider
 * future can land after the user has already left. What cannot happen is the
 * camera staying live with nothing on screen.
 */
class CameraLifecycleTest {

    @Test
    fun `binding then leaving releases once`() {
        var released = 0
        val lifecycle = CameraLifecycle()
        lifecycle.bound { released += 1 }
        lifecycle.release()
        lifecycle.release()
        assertEquals(1, released)
    }

    @Test
    fun `a provider that arrives after disposal is torn down immediately`() {
        var released = 0
        val lifecycle = CameraLifecycle()
        lifecycle.release()
        lifecycle.bound { released += 1 }
        assertEquals(1, released)
    }

    @Test
    fun `releasing without ever binding is harmless`() {
        CameraLifecycle().release()
    }

    @Test
    fun `an analyzer whose binding throws is still released`() {
        var released = 0
        val lifecycle = CameraLifecycle()
        val started = lifecycle.startAnalyzing(
            createAnalyzer = { "analyzer" },
            releaseAnalyzer = { released += 1 },
            bind = { error("no camera on this device") },
        )
        assertFalse(started)
        assertEquals(1, released)
        // Leaving the screen afterwards must not release it a second time.
        lifecycle.release()
        assertEquals(1, released)
    }

    @Test
    fun `a bound analyzer is released when the screen goes away`() {
        var released = 0
        var bound = 0
        val lifecycle = CameraLifecycle()
        val started = lifecycle.startAnalyzing(
            createAnalyzer = { "analyzer" },
            releaseAnalyzer = { released += 1 },
            bind = { bound += 1 },
        )
        assertTrue(started)
        assertEquals(1, bound)
        assertEquals(0, released)
        lifecycle.release()
        assertEquals(1, released)
    }

    @Test
    fun `rebinding releases what was held before`() {
        var first = 0
        var second = 0
        val lifecycle = CameraLifecycle()
        lifecycle.bound { first += 1 }
        lifecycle.bound { second += 1 }
        assertEquals(1, first)
        lifecycle.release()
        assertEquals(1, second)
    }
}
