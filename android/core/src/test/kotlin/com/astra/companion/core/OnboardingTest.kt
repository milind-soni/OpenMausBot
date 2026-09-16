package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * The first-run routing rules — the port of
 * `ios/Tests/CompanionCoreTests/OnboardingTests.swift:6-162,239-249`.
 *
 * Two of that file's cases are not repeated here because Android already
 * answers them, in stronger form and somewhere else:
 *
 * - `testPairingSubmissionBlocksResetUntilTheAttemptSettles` — iOS's
 *   `CompanionPairingSubmissionState` is a boolean beside the credential.
 *   Android's `PairingSecrets` owns the credential slot itself, so refusing a
 *   second submit is a property of the store rather than a flag a screen may
 *   forget to read; `PairingSecretStoreTest` covers it.
 * - `testPairingInviteQueueClearsAcrossSuccessAndSignOutSequence` — the queue
 *   lives inside `Session` on Android, and `SessionInviteLifecycleTest` drives
 *   it through the same success/unpair sequence against a real session.
 *
 * `testPendingNotificationPreferenceSurvivesAProcessRelaunch` is durability, not
 * routing; it is ported in `:app` against a real `SharedPreferences` file, where
 * durability can actually be observed.
 */
class OnboardingTest {

    private fun route(
        pairingState: OnboardingPairingState,
        hasSeenWelcome: Boolean,
        pairingRequested: Boolean = false,
        hasPendingPairingInvite: Boolean = false,
        notificationOnboardingPending: Boolean = false,
        hasSeenNotificationPrompt: Boolean = false,
        notificationAuthorization: NotificationAuthorizationState =
            NotificationAuthorizationState.NOT_DETERMINED,
    ) = OnboardingRouter.route(
        OnboardingContext(
            pairingState = pairingState,
            hasSeenWelcome = hasSeenWelcome,
            pairingRequested = pairingRequested,
            hasPendingPairingInvite = hasPendingPairingInvite,
            notificationOnboardingPending = notificationOnboardingPending,
            hasSeenNotificationPrompt = hasSeenNotificationPrompt,
            notificationAuthorization = notificationAuthorization,
        ),
    )

    @Test
    fun firstLaunchShowsWelcome() {
        assertEquals(
            OnboardingRoute.WELCOME,
            route(OnboardingPairingState.UNPAIRED, hasSeenWelcome = false),
        )
    }

    @Test
    fun skipShowsUsefulUnpairedHome() {
        assertEquals(
            OnboardingRoute.UNPAIRED_HOME,
            route(OnboardingPairingState.UNPAIRED, hasSeenWelcome = true),
        )
    }

    @Test
    fun resumeAndPendingInviteBothOpenPairing() {
        assertEquals(
            OnboardingRoute.PAIRING,
            route(
                OnboardingPairingState.UNPAIRED,
                hasSeenWelcome = true,
                pairingRequested = true,
            ),
        )
        // A deep link opens pairing even on a first launch that has not been
        // answered: the person is arriving from the QR code, not from the app.
        assertEquals(
            OnboardingRoute.PAIRING,
            route(
                OnboardingPairingState.UNPAIRED,
                hasSeenWelcome = false,
                hasPendingPairingInvite = true,
            ),
        )
    }

    @Test
    fun existingPairedUserGoesStraightToChats() {
        assertEquals(
            OnboardingRoute.CHATS,
            route(OnboardingPairingState.PAIRED, hasSeenWelcome = true),
        )
    }

    @Test
    fun pairedUserCanOpenPairingToAddAnotherComputer() {
        assertEquals(
            OnboardingRoute.PAIRING,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                pairingRequested = true,
            ),
        )
        assertEquals(
            OnboardingRoute.PAIRING,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                hasPendingPairingInvite = true,
            ),
        )
    }

    @Test
    fun justPairedUserSeesNotificationExplanationOnceThenChats() {
        assertEquals(
            OnboardingRoute.NOTIFICATION_PROMPT,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                notificationAuthorization = NotificationAuthorizationState.NOT_DETERMINED,
            ),
        )
        // Answered once, either way.
        assertEquals(
            OnboardingRoute.CHATS,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                hasSeenNotificationPrompt = true,
            ),
        )
        // Nothing left to ask: the system has already decided, in either
        // direction, so an explanation would end in a button that does nothing.
        assertEquals(
            OnboardingRoute.CHATS,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                notificationAuthorization = NotificationAuthorizationState.DETERMINED,
            ),
        )
    }

    @Test
    fun pendingNotificationEducationSurvivesUnresolvedLaunchAndRelaunch() {
        assertEquals(
            OnboardingRoute.CHATS,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                notificationAuthorization = NotificationAuthorizationState.UNRESOLVED,
            ),
            "an unresolved answer is not permission to show the step",
        )
        assertTrue(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = true,
                hasCompletedStep = false,
                authorization = NotificationAuthorizationState.UNRESOLVED,
            ),
            "and it is certainly not permission to spend the marker",
        )

        // A second process launch reads the same durable marker. Once the answer
        // resolves to not-determined, the step has to reappear.
        assertEquals(
            OnboardingRoute.NOTIFICATION_PROMPT,
            route(
                OnboardingPairingState.PAIRED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                notificationAuthorization = NotificationAuthorizationState.NOT_DETERMINED,
            ),
        )
        assertTrue(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = true,
                hasCompletedStep = false,
                authorization = NotificationAuthorizationState.NOT_DETERMINED,
            ),
        )
    }

    @Test
    fun pairingCommitMarksNotificationStepBeforeSavingConnection() = runTest {
        val writes = mutableListOf<String>()

        PairingCommitSequence.persist(
            markNotificationOnboardingPending = { writes += "notification-pending" },
            saveConnection = { writes += "connection" },
        )

        assertEquals(listOf("notification-pending", "connection"), writes)
    }

    @Test
    fun resolvedOrCompletedNotificationEducationClearsPendingMarker() {
        assertFalse(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = true,
                hasCompletedStep = false,
                authorization = NotificationAuthorizationState.DETERMINED,
            ),
        )
        assertFalse(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = true,
                hasCompletedStep = true,
                authorization = NotificationAuthorizationState.NOT_DETERMINED,
            ),
        )
        // Completed *and* unresolved still keeps it: the answer is not in yet,
        // and a marker spent on a guess cannot be recovered.
        assertTrue(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = true,
                hasCompletedStep = true,
                authorization = NotificationAuthorizationState.UNRESOLVED,
            ),
        )
        // Nothing pending is nothing to keep, whatever else is true.
        assertFalse(
            NotificationOnboardingPolicy.shouldKeepPending(
                isPending = false,
                hasCompletedStep = false,
                authorization = NotificationAuthorizationState.UNRESOLVED,
            ),
        )
    }

    @Test
    fun clearedDeferredInviteCannotReopenPairingAfterLaterUnpair() {
        assertEquals(
            OnboardingRoute.PAIRING,
            route(
                OnboardingPairingState.UNPAIRED,
                hasSeenWelcome = true,
                hasPendingPairingInvite = true,
            ),
        )
        // The pairing succeeded and consumed the invite; a later unpair must not
        // find a stale reason to reopen the form.
        assertEquals(
            OnboardingRoute.UNPAIRED_HOME,
            route(
                OnboardingPairingState.UNPAIRED,
                hasSeenWelcome = true,
                hasPendingPairingInvite = false,
            ),
        )
    }

    @Test
    fun revokedPairingAlwaysShowsRecovery() {
        assertEquals(
            OnboardingRoute.REVOKED,
            route(
                OnboardingPairingState.REVOKED,
                hasSeenWelcome = false,
                pairingRequested = true,
                hasPendingPairingInvite = true,
            ),
            "revocation outranks a requested pairing and a pending deep link",
        )
        // And it outranks the education step, which is the other route a paired
        // phone could plausibly be sent to.
        assertEquals(
            OnboardingRoute.REVOKED,
            route(
                OnboardingPairingState.REVOKED,
                hasSeenWelcome = true,
                notificationOnboardingPending = true,
                notificationAuthorization = NotificationAuthorizationState.NOT_DETERMINED,
            ),
        )
    }

    /**
     * The whole table, so a rewrite of [OnboardingRouter] that happens to keep
     * the cases above passing cannot quietly move a state nobody named.
     */
    @Test
    fun everyCombinationOfTheThreeUnpairedInputsIsAccountedFor() {
        val expected = mapOf(
            // hasSeenWelcome, pairingRequested, hasPendingPairingInvite
            Triple(false, false, false) to OnboardingRoute.WELCOME,
            Triple(true, false, false) to OnboardingRoute.UNPAIRED_HOME,
            Triple(false, true, false) to OnboardingRoute.PAIRING,
            Triple(true, true, false) to OnboardingRoute.PAIRING,
            Triple(false, false, true) to OnboardingRoute.PAIRING,
            Triple(true, false, true) to OnboardingRoute.PAIRING,
            Triple(false, true, true) to OnboardingRoute.PAIRING,
            Triple(true, true, true) to OnboardingRoute.PAIRING,
        )
        for ((inputs, want) in expected) {
            val (seen, requested, invited) = inputs
            assertEquals(
                want,
                route(
                    OnboardingPairingState.UNPAIRED,
                    hasSeenWelcome = seen,
                    pairingRequested = requested,
                    hasPendingPairingInvite = invited,
                ),
                "welcome=$seen requested=$requested invite=$invited",
            )
        }
    }
}
