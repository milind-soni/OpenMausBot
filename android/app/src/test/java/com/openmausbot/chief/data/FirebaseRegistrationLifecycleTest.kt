package com.openmausbot.chief.data

import org.junit.Assert.assertEquals
import org.junit.Test

class FirebaseRegistrationLifecycleTest {
    @Test
    fun registeredInstallationIsSentOnlyWhenPaired() {
        var registration: Pair<PairedSession, String>? = null
        val session = session()

        FirebaseRegistrationLifecycle.onRegistered(null, "fid-1") { paired, id -> registration = paired to id }
        assertEquals(null, registration)

        FirebaseRegistrationLifecycle.onRegistered(session, "fid-1") { paired, id -> registration = paired to id }
        assertEquals(session to "fid-1", registration)
    }

    @Test
    fun blankInstallationIdsAreIgnoredAndUnregisterRevokesOnlyPairedTarget() {
        var registrations = 0
        var revocations = 0
        val session = session()

        FirebaseRegistrationLifecycle.onRegistered(session, "") { _, _ -> registrations++ }
        FirebaseRegistrationLifecycle.onUnregistered(null) { revocations++ }
        FirebaseRegistrationLifecycle.onUnregistered(session) { revocations++ }

        assertEquals(0, registrations)
        assertEquals(1, revocations)
    }

    private fun session() = PairedSession(
        SavedConnection(name = "Office", origin = "https://example.com", allowedKinds = setOf("hosted")),
        "omb_secret",
    )
}
