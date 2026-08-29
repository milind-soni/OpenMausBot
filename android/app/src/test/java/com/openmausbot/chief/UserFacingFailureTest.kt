package com.openmausbot.chief

import kotlinx.coroutines.CancellationException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UserFacingFailureTest {
    @Test
    fun coroutineCancellationNeverBecomesAFlashingUserError() {
        assertThrows(CancellationException::class.java) {
            userFacingFailureMessage(CancellationException("StandaloneCoroutine was cancelled"))
        }
    }

    @Test
    fun wrappedCoroutineCancellationNeverBecomesAFlashingUserError() {
        assertThrows(CancellationException::class.java) {
            userFacingFailureMessage(
                IllegalStateException(
                    "Refresh failed",
                    CancellationException("StandaloneCoroutine was cancelled"),
                ),
            )
        }
    }

    @Test
    fun realFailuresStillProduceAnActionableMessage() {
        assertEquals(
            "Network unavailable",
            userFacingFailureMessage(IllegalStateException("Network unavailable")),
        )
    }

    @Test
    fun dnsFailuresDoNotExposeRawHostExceptions() {
        assertEquals(
            "Could not reach Agent Centipede. Make sure the computer is awake and the desktop app is running.",
            userFacingFailureMessage(UnknownHostException("Unable to resolve host old-host.example")),
        )
    }
}
