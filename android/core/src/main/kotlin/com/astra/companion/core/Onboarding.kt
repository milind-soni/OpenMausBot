package com.astra.companion.core

/**
 * The first-run decision seam — the port of
 * `ios/Sources/CompanionCore/Onboarding.swift`.
 *
 * It lives outside Compose for the same reason it lives outside SwiftUI: the
 * transitions that matter are the ones nobody sees until they are wrong.
 * Skipping setup must not look like a pairing, a deep link that arrived while
 * the app was closed must still open pairing, and a revoked credential must
 * never fall through to an ordinary empty state.
 *
 * What is ported here is the **timing and the routing**. The painting is
 * Material's, and deliberately not SwiftUI's.
 */
enum class OnboardingPairingState {
    UNPAIRED,
    PAIRED,
    REVOKED,
}

enum class OnboardingRoute {
    WELCOME,
    PAIRING,
    UNPAIRED_HOME,
    NOTIFICATION_PROMPT,
    CHATS,
    REVOKED,
}

/**
 * Whether the app yet knows what the system will say about notifications.
 *
 * iOS reads this asynchronously at launch, and treating that short unresolved
 * window as a final answer can skip first-pair education forever. Android
 * answers synchronously today, so [UNRESOLVED] is produced by the durable side
 * instead — see `OnboardingPreferences` in `:app`. The rule the third case
 * carries is not iOS's async quirk: **nothing may spend the marker on an
 * answer the app does not have.**
 */
enum class NotificationAuthorizationState {
    UNRESOLVED,
    NOT_DETERMINED,
    DETERMINED,
}

/**
 * Durable preference names shared by the pairing commit and the root router.
 *
 * The pending marker is deliberately separate from the benign "already saw
 * this" preference: a new pairing may finish before the app knows the current
 * notification authorization, and the two answers are not the same question.
 *
 * None of these is a secret and none may become a place where anything else
 * rides along (§6): the store that holds them accepts booleans and nothing
 * else, and `OnboardingPreferencesContractTest` in `:app` holds it to that.
 */
object OnboardingPreferenceKeys {
    const val PENDING_NOTIFICATION_ONBOARDING = "companion.onboarding.notificationPending"
    const val WELCOME_SEEN = "companion.onboarding.welcomeSeen"
    const val NOTIFICATION_PROMPT_SEEN = "companion.onboarding.notificationsSeen"

    /** Everything this app is allowed to keep in the onboarding store. */
    val ALL: Set<String> = setOf(
        PENDING_NOTIFICATION_ONBOARDING,
        WELCOME_SEEN,
        NOTIFICATION_PROMPT_SEEN,
    )
}

/**
 * Keeps the crash-sensitive half of a successful pairing commit explicit, and
 * therefore testable.
 *
 * The notification marker has to exist **before** the connection becomes
 * restorable. An orphan marker while unpaired is harmless — the router only
 * reaches the education step from [OnboardingPairingState.PAIRED] — but a
 * connection restored without its marker permanently skips first-pair
 * education, and there is no later moment that can tell it should not have.
 */
object PairingCommitSequence {
    suspend fun persist(
        markNotificationOnboardingPending: suspend () -> Unit,
        saveConnection: suspend () -> Unit,
    ) {
        markNotificationOnboardingPending()
        saveConnection()
    }
}

/** Pure lifecycle policy for the durable first-pair notification marker. */
object NotificationOnboardingPolicy {
    fun shouldKeepPending(
        isPending: Boolean,
        hasCompletedStep: Boolean,
        authorization: NotificationAuthorizationState,
    ): Boolean {
        if (!isPending) return false
        // A relaunch can restore the pairing before the app knows what the
        // system will say. Never spend the marker during that window.
        if (authorization == NotificationAuthorizationState.UNRESOLVED) return true
        // Once the answer is known, education is needed only while the system
        // can still be asked and this person has not already done or skipped
        // the step.
        return authorization == NotificationAuthorizationState.NOT_DETERMINED && !hasCompletedStep
    }
}

data class OnboardingContext(
    val pairingState: OnboardingPairingState,
    val hasSeenWelcome: Boolean,
    val pairingRequested: Boolean = false,
    val hasPendingPairingInvite: Boolean = false,
    /**
     * Written only when a new pairing commits. People who were already paired
     * do not receive first-pair education merely because they updated the app.
     */
    val notificationOnboardingPending: Boolean = false,
    val hasSeenNotificationPrompt: Boolean = false,
    val notificationAuthorization: NotificationAuthorizationState =
        NotificationAuthorizationState.NOT_DETERMINED,
)

object OnboardingRouter {
    fun route(context: OnboardingContext): OnboardingRoute = when (context.pairingState) {
        // First, and unconditionally. A revoked token with a pending invite and
        // a requested pairing is still a revoked token: recovery outranks every
        // other reason this screen could be shown.
        OnboardingPairingState.REVOKED -> OnboardingRoute.REVOKED

        OnboardingPairingState.PAIRED ->
            if (context.pairingRequested || context.hasPendingPairingInvite) {
                // Adding a computer deliberately overlays pairing over a live
                // session. The old computer is not replaced until commit.
                OnboardingRoute.PAIRING
            } else if (context.notificationOnboardingPending &&
                !context.hasSeenNotificationPrompt &&
                context.notificationAuthorization == NotificationAuthorizationState.NOT_DETERMINED
            ) {
                OnboardingRoute.NOTIFICATION_PROMPT
            } else {
                OnboardingRoute.CHATS
            }

        OnboardingPairingState.UNPAIRED ->
            if (context.pairingRequested || context.hasPendingPairingInvite) {
                OnboardingRoute.PAIRING
            } else if (context.hasSeenWelcome) {
                OnboardingRoute.UNPAIRED_HOME
            } else {
                OnboardingRoute.WELCOME
            }
    }
}
