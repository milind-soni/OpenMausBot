package com.astra.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Who gets a join button, and what a still frame is claiming — the rules from
 * `ios/App/ComputerView.swift`.
 */
class ComputerPolicyTest {

    @Test
    fun `only a cloud bot offers the live desktop`() {
        assertTrue(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "cloud")))
        // Local VM and "this Mac" show the preview and no join button (§10).
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "local")))
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = "mac")))
        assertFalse(ComputerPolicy.showsCloudDesktop(bot(id = "b").copy(computer = null)))
    }

    @Test
    fun `a VPS-backed cloud bot gets no button, because the server would refuse`() {
        assertFalse(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = "vps"),
            ),
        )
    }

    @Test
    fun `an older harness that never sends cloudBackend keeps the button`() {
        assertTrue(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = null),
            ),
        )
    }

    @Test
    fun `a non-vps backend keeps the button`() {
        assertTrue(
            ComputerPolicy.showsCloudDesktop(
                bot(id = "b").copy(computer = "cloud", cloudBackend = "fly"),
            ),
        )
    }

    /**
     * The note tells the person where to switch VNC on, so it has to name the
     * section the desktop has: Phone (`ios/App/ComputerView.swift:89`).
     */
    @Test
    fun `the VNC note names the desktop section that exists`() {
        assertEquals(
            "Interactive VNC session. Access must be enabled for this phone in the computer's " +
                "Phone settings.",
            ComputerPolicy.VNC_NOTE,
        )
    }

    @Test
    fun `the status label says whether the picture is still arriving`() {
        assertEquals("Preview", ComputerPolicy.statusLabel(bot(id = "b", busy = true)))
        assertEquals("Idle", ComputerPolicy.statusLabel(bot(id = "b", busy = false)))
        assertEquals("Idle", ComputerPolicy.statusLabel(bot(id = "b", busy = null)))
    }

    @Test
    fun `an idle bot explains why there is nothing to watch`() {
        assertTrue(ComputerPolicy.explainsIdle(bot(id = "b", busy = false)))
        assertFalse(ComputerPolicy.explainsIdle(bot(id = "b", busy = true)))
        assertEquals("Nothing to show yet", ComputerPolicy.waitingHeadline(bot(id = "b")))
        assertEquals(
            "Waiting for a frame…",
            ComputerPolicy.waitingHeadline(bot(id = "b", busy = true)),
        )
    }
}

/**
 * Frames are hundreds of kilobytes each, so the watcher count decides whether the
 * stream carries them at all. A count that drifts either pulls screenshots
 * forever or turns them off under an open screen.
 */
class ScreenWatchTest {

    @Test
    fun `watching then leaving starts and stops once`() {
        val started = mutableListOf<String>()
        val stopped = mutableListOf<String>()
        val watch = ScreenWatch(start = { started += it }, stop = { stopped += it })

        watch.watch("bot-1")
        watch.release()
        watch.release()

        assertEquals(listOf("bot-1"), started)
        assertEquals(listOf("bot-1"), stopped)
    }

    @Test
    fun `releasing without watching stops nothing`() {
        val stopped = mutableListOf<String>()
        ScreenWatch(start = {}, stop = { stopped += it }).release()
        assertEquals(emptyList(), stopped)
    }

    @Test
    fun `watching the same bot twice does not double-count`() {
        val started = mutableListOf<String>()
        val stopped = mutableListOf<String>()
        val watch = ScreenWatch(start = { started += it }, stop = { stopped += it })

        watch.watch("bot-1")
        watch.watch("bot-1")

        assertEquals(listOf("bot-1"), started)
        assertEquals(emptyList(), stopped)
    }

    @Test
    fun `switching bots releases the first before taking the second`() {
        val calls = mutableListOf<String>()
        val watch = ScreenWatch(start = { calls += "start:$it" }, stop = { calls += "stop:$it" })

        watch.watch("bot-1")
        watch.watch("bot-2")
        watch.release()

        assertEquals(
            listOf("start:bot-1", "stop:bot-1", "start:bot-2", "stop:bot-2"),
            calls,
        )
    }

    @Test
    fun `every start is matched by exactly one stop`() {
        var balance = 0
        val watch = ScreenWatch(start = { balance += 1 }, stop = { balance -= 1 })

        watch.watch("bot-1")
        watch.watch("bot-2")
        watch.watch("bot-2")
        watch.watch("bot-3")
        watch.release()
        watch.release()

        assertEquals(0, balance)
    }
}
