package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.NotificationAuthorizationState
import com.openmausbot.companion.core.NotificationOnboardingPolicy
import com.openmausbot.companion.core.NotificationTarget
import com.openmausbot.companion.core.OnboardingContext
import com.openmausbot.companion.core.OnboardingPairingState
import com.openmausbot.companion.core.OnboardingRoute
import com.openmausbot.companion.core.OnboardingRouter
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.launch

/**
 * Which of the six worlds the app is in — the port of `RootView` in
 * `ios/App/CompanionApp.swift`.
 *
 * The decision itself is not here. It is
 * [com.openmausbot.companion.core.OnboardingRouter], in `:core`, because the
 * orderings that matter are invisible until they are wrong: revocation has to
 * outrank a pending deep link, a deep link has to outrank the welcome, and a
 * pairing someone already had must never be handed first-pair education. This
 * file's job is to hand the router honest inputs and to render what it answers.
 *
 * **Nothing here asks the system for a permission.** It used to: the first frame
 * fired a batch request for notifications *and* nearby devices before the app
 * had said what it was, which made refusing both the reasonable answer. Each
 * permission now belongs to the moment it is earned — notifications to the
 * explained step after a first pairing ([NotificationOnboardingScreen]), nearby
 * devices to opening the list of computers ([PairingScreen]).
 */
@Composable
fun CompanionRoot(
    pendingNotification: NotificationTarget?,
    onPendingTargetConsumed: (NotificationTarget) -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val onboarding = environment.onboarding
    val scope = rememberCoroutineScope()

    val status by session.status.collectAsState()
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val pairingRequested by session.pairingRequested.collectAsState()
    val invite by session.pairingInvite.collectAsState()
    val restoreState by session.restoreState.collectAsState()
    val notificationAccess by environment.notifications.access.collectAsState()
    val welcomeSeen by onboarding.welcomeSeen.collectAsState()
    val notificationPromptSeen by onboarding.notificationPromptSeen.collectAsState()
    val notificationPending by onboarding.notificationPending.collectAsState()

    // Settings, reachable from the unpaired home. iOS puts it in a toolbar
    // `NavigationLink`; there is no navigator in the unpaired world, so this is
    // the whole of that stack.
    var showingUnpairedSettings by rememberSaveable { mutableStateOf(false) }
    var enablingNotifications by remember { mutableStateOf(false) }

    val authorization = notificationAuthorization(notificationAccess)
    val route = OnboardingRouter.route(
        OnboardingContext(
            pairingState = onboardingPairingState(status, connection),
            hasSeenWelcome = welcomeSeen,
            pairingRequested = pairingRequested,
            hasPendingPairingInvite = invite != null,
            notificationOnboardingPending = notificationPending,
            hasSeenNotificationPrompt = notificationPromptSeen,
            notificationAuthorization = authorization,
        ),
    )

    /**
     * Settle the durable marker against what is now known.
     *
     * Reads the flows rather than the values captured by this composition: the
     * coroutine may run after another write landed, and the marker is the one
     * piece of state here that a stale snapshot could destroy.
     */
    fun reconcileNotificationOnboarding() {
        scope.launch {
            onboarding.setNotificationOnboardingPending(
                NotificationOnboardingPolicy.shouldKeepPending(
                    isPending = onboarding.notificationPending.value,
                    hasCompletedStep = onboarding.notificationPromptSeen.value,
                    authorization = authorization,
                ),
            )
        }
    }

    fun startPairing() {
        scope.launch { onboarding.setWelcomeSeen(true) }
        session.beginPairing()
    }

    /**
     * Both answers to the education step end it: the step records that it was
     * answered, and that is *all* it records.
     *
     * Spending the marker is deliberately not done here. It belongs to
     * [NotificationOnboardingPolicy] and reaches disk through the one
     * reconciliation below, so there is a single place that decides when a
     * marker is spent instead of three that have to agree.
     */
    fun finishNotificationStep() {
        scope.launch { onboarding.setNotificationPromptSeen(true) }
    }

    // Back closes Settings rather than the app. The paired world gets this from
    // its navigator; the unpaired home has no navigator, and without this line
    // the first thing a person who opened Settings from it presses puts them
    // back on the launcher.
    BackHandler(enabled = showingUnpairedSettings) { showingUnpairedSettings = false }
    // Leaving this world closes it too, so a later unpair does not land on a
    // Settings screen nobody asked for.
    LaunchedEffect(route) {
        if (route != OnboardingRoute.UNPAIRED_HOME) showingUnpairedSettings = false
    }

    // A pairing that commits answers the welcome and ends the request that
    // opened the form, wherever the person came in from — the welcome, the
    // unpaired home, or a deep link on a first launch nobody had answered.
    //
    // One place. iOS spreads the same two writes over `ChatListView.onAppear`
    // and the education step's `onContinue`, which means two copies of "the
    // request is over" that have to stay in agreement; a stale one is what lets
    // a much later voluntary unpair walk straight back into the pairing form.
    LaunchedEffect(connection != null) {
        if (connection == null) return@LaunchedEffect
        onboarding.setWelcomeSeen(true)
        // A new connection can be added while another is already non-null, so
        // only Session (which knows the redemption result) ends the request.
    }
    // The only thing that spends the marker. One effect, keyed on every input
    // the policy reads, so it runs at launch and again whenever any of them
    // moves — an answer arriving, the step being answered, a fresh pairing
    // setting the marker. Splitting this across the screens that happen to be
    // on top when each changes is how a rule ends up true in one copy and false
    // in another.
    LaunchedEffect(authorization, notificationPromptSeen, notificationPending) {
        reconcileNotificationOnboarding()
    }

    // Resolve above every screen so a tap while unpaired or unauthorized is
    // consumed (and cannot open against the next bond). Re-runs when restoreState
    // leaves Pending so a deferred target is not stranded after a cold-start
    // restore that finishes unpaired. The coordinator owns every consume:
    // identified no-chat inside onPending, and navigate→consume inside commit.
    // RootScreen cannot omit or invert.
    val tapCoordinator = remember { NotificationTapCoordinator() }
    val resolution by tapCoordinator.resolution.collectAsState()
    // Persistable: bumping this keys the navigator saver with a generation that
    // is also written into the saved value, so a stack captured while
    // Unauthorized/Unpaired was landing cannot restore after the next pair (§6).
    var bondGeneration by rememberSaveable { mutableIntStateOf(0) }

    LaunchedEffect(status) {
        if (NotificationTapCoordinator.leavesBond(status)) {
            tapCoordinator.discardResolved()
            bondGeneration += 1
        }
    }
    LaunchedEffect(pendingNotification, status, restoreState) {
        val target = pendingNotification ?: return@LaunchedEffect
        tapCoordinator.onPending(session, target, onPendingTargetConsumed)
    }

    CompanionTheme {
        // One place for system insets: the app draws edge to edge, and every
        // screen wants the same answer — keep content clear of the status bar,
        // the gesture bar, and the keyboard.
        Box(modifier = Modifier.fillMaxSize()) {
            Surface(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
                Box(modifier = Modifier.fillMaxSize()) {
                    when (route) {
                        OnboardingRoute.WELCOME -> WelcomeScreen(
                            onConnect = ::startPairing,
                            onSkip = {
                                // "Not now" is an answer, not a postponement of the same
                                // screen: it is remembered, and it leads to a home that
                                // can still connect and still reach Settings.
                                scope.launch { onboarding.setWelcomeSeen(true) }
                                session.endPairing()
                            },
                        )

                        OnboardingRoute.PAIRING -> {
                            // Being on this screen *is* the request, and it is what
                            // keeps the screen up after `PairingScreen` consumes the
                            // invite that opened it — at which point
                            // `hasPendingPairingInvite` goes false and this is the only
                            // thing left holding the route.
                            LaunchedEffect(Unit) {
                                onboarding.setWelcomeSeen(true)
                                session.beginPairing()
                            }
                            PairingScreen(
                                onCancel = {
                                    scope.launch { onboarding.setWelcomeSeen(true) }
                                    session.endPairing()
                                },
                            )
                        }

                        OnboardingRoute.UNPAIRED_HOME -> if (showingUnpairedSettings) {
                            // The same Settings screen, minus what needs a pairing.
                            // Notifications can be recovered from here without first
                            // entering a connection flow this person just declined.
                            SettingsScreen(
                                onBack = { showingUnpairedSettings = false },
                                onConnect = {
                                    showingUnpairedSettings = false
                                    startPairing()
                                },
                            )
                        } else {
                            UnpairedHomeScreen(
                                onConnect = ::startPairing,
                                onOpenSettings = { showingUnpairedSettings = true },
                            )
                        }

                        OnboardingRoute.NOTIFICATION_PROMPT -> {
                            NotificationOnboardingScreen(
                                enabling = enablingNotifications,
                                onEnable = {
                                    enablingNotifications = true
                                    scope.launch {
                                        // Marked before the prompt is launched, the way
                                        // [PermissionRequests] records every asking as
                                        // part of launching it: a process that dies while
                                        // the system sheet is up has still spent the
                                        // prompt, and re-showing this step afterwards
                                        // would offer a button the OS silently drops.
                                        onboarding.setNotificationPromptSeen(true)
                                        environment.notifications.act()
                                        enablingNotifications = false
                                    }
                                },
                                onSkip = ::finishNotificationStep,
                            )
                        }

                        OnboardingRoute.CHATS -> {
                            PairedScreen(
                                resolution = resolution,
                                bondGeneration = bondGeneration,
                                onCommit = { held, navigator ->
                                    tapCoordinator.commit(held, navigator, onPendingTargetConsumed)
                                },
                            )
                        }

                        OnboardingRoute.REVOKED -> UnpairedScreen(
                            onPairAgain = {
                                session.signOut()
                                startPairing()
                            },
                            onChooseAnother = connections.firstOrNull { it.id != connection?.id }
                                ?.let { other -> { session.switchComputer(other.id) } },
                        )
                    }
                    val pendingShare by environment.shareInbox.pending.collectAsState()
                    pendingShare?.let { share ->
                        ShareSheet(pending = share, onDismiss = environment.shareInbox::consume)
                    }
                }
            }
            // Pairing failures are shown inline on the pairing form, where the
            // action was — a modal on top of it would say the same thing twice.
            if (route != OnboardingRoute.PAIRING) {
                ActionErrorDialog(session)
            }
        }
    }
}

/**
 * Which of the three worlds the pairing is in, as the router asks the question.
 *
 * Revocation is tested first and unconditionally. A token the computer retired
 * is not an empty state and not a pairing: it has its own screen, and no pending
 * invite or requested pairing may push it aside.
 */
internal fun onboardingPairingState(
    status: Session.Status,
    connection: Connection?,
): OnboardingPairingState = when {
    status is Session.Status.Unauthorized -> OnboardingPairingState.REVOKED
    connection != null -> OnboardingPairingState.PAIRED
    else -> OnboardingPairingState.UNPAIRED
}

/**
 * The notification permission, as the marker's lifecycle asks about it.
 *
 * Android answers synchronously — `areNotificationsEnabled()` and
 * `shouldShowRequestPermissionRationale()` both return immediately — so unlike
 * iOS there is no launch window here where the answer is unknown, and
 * [NotificationAuthorizationState.UNRESOLVED] is not produced by this mapping.
 * It exists in the router because the rule it carries is the marker's
 * protection, not iOS's async quirk.
 *
 * [NotificationAccess.BLOCKED] is DETERMINED rather than a fourth case: it means
 * the system will not ask again — pre-33, where there is no runtime permission
 * at all, or a prompt already spent. Education that ends in a button the OS
 * silently drops is worse than no education, so the step is skipped and Settings
 * keeps the recovery path.
 */
internal fun notificationAuthorization(
    access: NotificationAccess,
): NotificationAuthorizationState = when (access) {
    NotificationAccess.ASKABLE -> NotificationAuthorizationState.NOT_DETERMINED
    NotificationAccess.GRANTED, NotificationAccess.BLOCKED ->
        NotificationAuthorizationState.DETERMINED
}

@Composable
private fun PairedScreen(
    resolution: NotificationTapCoordinator.Resolution?,
    bondGeneration: Int,
    onCommit: (NotificationTapCoordinator.Resolution, CompanionNavigator) -> Unit,
) {
    val navigator = rememberCompanionNavigator(bondGeneration)

    // Session already resolved the exact task; the coordinator records the
    // stack and consumes in one commit — keyed on generation so a superseded
    // tap cannot run against a newer pending target.
    LaunchedEffect(resolution?.generation) {
        val held = resolution ?: return@LaunchedEffect
        onCommit(held, navigator)
    }

    BackHandler(enabled = navigator.canGoBack) { navigator.pop() }

    when (val destination = navigator.current) {
        Destination.Roster -> RosterScreen(navigator)
        Destination.Settings -> SettingsScreen(
            onBack = navigator::pop,
            onOpenRoutines = { navigator.push(Destination.Routines) },
            onOpenConnectedApps = { navigator.push(Destination.ConnectedApps) },
        )
        Destination.Routines -> TasksRoutinesScreen(
            onBack = navigator::pop,
            // A receipt's "Open task" pushes the chat above this screen, the way
            // iOS appends it to the same navigation path.
            onOpenChat = navigator::open,
        )
        Destination.ConnectedApps -> ConnectedAppsScreen(onBack = navigator::pop)
        // One branch for both shapes of chat address, so a notification's thread
        // becoming an addressed chat re-reads the same screen instead of
        // rebuilding it.
        is Destination.Conversation -> ChatScreen(
            destination = destination,
            onResolved = { target ->
                (destination as? Destination.Thread)?.let {
                    navigator.resolveThread(it.threadId, target)
                }
            },
            onBack = navigator::pop,
            onOpenComputer = { navigator.push(Destination.Computer(it)) },
            onOpenOverview = { navigator.push(Destination.Overview(it)) },
            // Push Computer keeps the chat under the top; pop to roster does not.
            retainsDraft = navigator::retainsChatDraft,
        )
        is Destination.Computer -> ComputerScreen(
            botId = destination.botId,
            onBack = navigator::pop,
        )
        is Destination.Overview -> BotOverviewScreen(
            botId = destination.botId,
            onBack = navigator::pop,
        )
    }
}

@Composable
private fun ActionErrorDialog(session: Session) {
    val message by session.actionErrorFlow.collectAsState()
    val text = message ?: return
    AlertDialog(
        onDismissRequest = { session.actionError = null },
        title = { Text("Something went wrong") },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = { session.actionError = null }) { Text("OK") }
        },
    )
}

/**
 * The token stopped working. Almost always because someone revoked this phone on
 * the computer — which is exactly what that button is for, so the honest thing is
 * to say so and offer to pair again.
 */
@Composable
private fun UnpairedScreen(onPairAgain: () -> Unit, onChooseAnother: (() -> Unit)? = null) {
    EmptyState(
        title = "This phone was unpaired",
        description = "It was removed from the computer's Phone settings, or the pairing was reset.",
    ) {
        Button(onClick = onPairAgain) { Text("Pair again") }
        onChooseAnother?.let { choose ->
            TextButton(onClick = choose) { Text("Use another computer") }
        }
    }
}

/** SwiftUI's `ContentUnavailableView`, near enough. */
@Composable
fun EmptyState(
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    actions: @Composable () -> Unit = {},
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = description,
            style = MaterialTheme.typography.bodyMedium,
            color = secondaryTint,
            textAlign = TextAlign.Center,
        )
        actions()
    }
}
