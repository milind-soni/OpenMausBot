package com.astra.companion.sharing

import com.astra.companion.ui.ShareLoadException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class ShareHandoffTest {
    @Test
    fun copyHappensBeforeTheRecordFinishesAndDeliveryFollowsFinish() = runBlocking {
        val order = mutableListOf<String>()
        val runnerThread = Thread.currentThread()
        var copyThread: Thread? = null
        ShareHandoff.run(
            copy = {
                copyThread = Thread.currentThread()
                order += "copy-start"
                // Real async work on IO — order is observed, not assembled by hand.
                Thread.sleep(40)
                order += "copy"
                SharePayload.Failed("ok")
            },
            relaunch = { order += "relaunch" },
            markFinishing = { order += "finish" },
            deliver = { order += "deliver" },
        )
        assertEquals(listOf("copy-start", "copy", "relaunch", "finish", "deliver"), order)
        assertTrue(order.indexOf("copy") < order.indexOf("finish"))
        assertTrue(order.indexOf("finish") < order.indexOf("deliver"))
        // Proves withContext(Dispatchers.IO): removing that hop leaves copy on the runner.
        assertNotEquals(runnerThread, copyThread)
    }

    @Test
    fun aCopyFailureStillRelaunchesFinishesAndDeliversTheError() = runBlocking {
        val order = mutableListOf<String>()
        var delivered: SharePayload? = null
        ShareHandoff.run(
            copy = {
                order += "copy"
                Thread.sleep(20)
                throw ShareLoadException("Send up to 4 items at a time.")
            },
            relaunch = { order += "relaunch" },
            markFinishing = { order += "finish" },
            deliver = {
                order += "deliver"
                delivered = it
            },
        )
        assertEquals(listOf("copy", "relaunch", "finish", "deliver"), order)
        assertEquals("Send up to 4 items at a time.", (delivered as SharePayload.Failed).message)
    }
}
