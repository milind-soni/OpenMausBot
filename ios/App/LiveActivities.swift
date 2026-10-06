// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, or working
// — started, updated and ended from the same `updates` the pill reads. The
// stream is foreground-only and there is no push path yet, so the island is
// exact while the app is alive and goes quiet with it; iOS keeps the last
// state on screen for a while, then the activity is ended on the next
// launch if the bot has moved on. Asks, kind changes and endings go out in
// the next 400 ms window; a working bot's streamed line alone is paced to
// one update every few seconds (`LiveActivityPacer`).
import ActivityKit
import Combine
import Foundation
import CompanionCore

/// ActivityKit's content/alert API is iOS 16.2, so the whole coordinator is
/// gated and simply never built on anything older. Those phones keep the app;
/// they just have no Dynamic Island, which they do not have hardware for
/// either.
@available(iOS 16.2, *)
@MainActor
final class LiveActivityCoordinator {
    private typealias BotActivity = Activity<BotActivityAttributes>

    private var cancellable: AnyCancellable?
    private weak var session: Session?
    /// One authorization reader for the coordinator's life, rather than a new
    /// one on every 400 ms sync. The reader itself is cheap (about 0.2 ms);
    /// most of a sync's main-thread time under a busy fleet is ActivityKit
    /// reading `Activity.activities`, which a sync now does once.
    private let authorization = ActivityAuthorizationInfo()
    /// Live Activities allowed in Settings: read once, then kept current by
    /// the reader's own update sequence, so a change there still applies.
    private var activitiesEnabled = false
    private var enablementTask: Task<Void, Never>?
    /// What each bot's activity last showed, and when: a working line alone
    /// updates at most every few seconds (`LiveActivityPacer`).
    private var pacer = LiveActivityPacer()
    /// When each bot's current kind began, so an update does not reset the clock.
    private var since: [String: (kind: ChatUpdate.Kind, at: Date)] = [:]
    /// One more sync when the earliest held line falls due, so a line held
    /// back just before the fleet went quiet still reaches the island.
    private var heldLineSync: Task<Void, Never>?
    private var heldLineDue: Date?

    func attach(to session: Session) {
        self.session = session
        activitiesEnabled = authorization.areActivitiesEnabled
        // A language change re-runs the scene's onAppear; the previous
        // reader loop must not outlive the attach that started it.
        enablementTask?.cancel()
        enablementTask = Task { [weak self, authorization] in
            for await enabled in authorization.activityEnablementUpdates {
                self?.activitiesEnabled = enabled
            }
        }
        // Answer from the island: the intent runs in this process.
        AnswerApprovalIntent.handler = { [weak self, weak session] threadId, requestId, choice, isPermission in
            await self?.answer(session: session, threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        // Do not debounce indefinitely while another bot is streaming.
        // The first window also lets cold-launch hydration settle.
        cancellable = session.$state
            .collect(.byTime(DispatchQueue.main, .milliseconds(400)))
            .compactMap(\.last)
            .sink { [weak self] state in self?.sync(state) }
    }

    private func answer(session: Session?, threadId: String, requestId: String, choice: String, isPermission: Bool) async {
        guard BotActivity.activities.contains(where: {
            $0.content.state.canAnswer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }) else {
            session?.actionError = "This request has changed. Open the chat to review it."
            return
        }
        await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
    }

    private func sync(_ state: CompanionState) {
        guard activitiesEnabled else { return }
        let now = Date()
        // One ActivityKit read per sync; the first activity per bot is the
        // one updated, as before, and every unwanted one is ended below.
        let running = BotActivity.activities
        var byBot: [String: BotActivity] = [:]
        for activity in running where byBot[activity.attributes.botId] == nil {
            byBot[activity.attributes.botId] = activity
        }
        var wantedIds = Set<String>()
        var earliestHeld: Date?

        for update in state.liveActivityUpdates(detail: .stored) {
            guard case let .bot(bot) = update.chat else { continue }
            wantedIds.insert(bot.id)
            if since[bot.id]?.kind != update.kind { since[bot.id] = (update.kind, now) }
            let face = MausState.forBot(bot, last: state.lastVisibleMessage(forThread: bot.threadId))
            let content = BotActivityAttributes.ContentState(
                update: update, face: face.rawValue, since: since[bot.id]?.at ?? now
            )
            switch pacer.decision(for: content, bot: bot.id, at: now) {
            case .unchanged:
                continue
            case let .held(until):
                earliestHeld = min(earliestHeld ?? until, until)
                continue
            case .send:
                let previous = pacer.lastSent(forBot: bot.id)
                pacer.record(content, bot: bot.id, at: now)
                send(content, replacing: previous, for: bot, isAsk: update.kind == .needsYou, to: byBot[bot.id])
            }
        }

        // bots that went quiet: let the island go
        for activity in running where !wantedIds.contains(activity.attributes.botId) {
            pacer.forget(bot: activity.attributes.botId)
            since.removeValue(forKey: activity.attributes.botId)
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        scheduleHeldLineSync(at: earliestHeld)
    }

    private func send(
        _ content: BotActivityAttributes.ContentState,
        replacing previous: BotActivityAttributes.ContentState?,
        for bot: Bot,
        isAsk: Bool,
        to existing: BotActivity?
    ) {
        // A bot stopping for you is worth an alert: the island pops open
        // on its own and the lock screen lights up. Working is not.
        let alert: AlertConfiguration? = isAsk
            ? AlertConfiguration(
                title: LocalizedStringResource(stringLiteral: content.headline),
                body: LocalizedStringResource(stringLiteral: content.line),
                sound: .default
            )
            : nil
        if let existing {
            let newAsk = isAsk && (previous?.threadId != content.threadId || previous?.requestId != content.requestId)
            Task { await existing.update(.init(state: content, staleDate: nil), alertConfiguration: newAsk ? alert : nil) }
            return
        }
        let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color)
        let created = try? BotActivity.request(attributes: attributes, content: .init(state: content, staleDate: nil), pushType: nil)
        // a fresh activity cannot alert on request; one immediate alerting update does it
        if let alert, let created {
            Task { await created.update(.init(state: content, staleDate: nil), alertConfiguration: alert) }
        }
    }

    /// Windows only close when the session publishes. A line held back in
    /// the last one before the fleet went quiet would otherwise stay
    /// unsent, so one more sync runs when the earliest hold falls due.
    private func scheduleHeldLineSync(at due: Date?) {
        guard due != heldLineDue else { return }
        heldLineSync?.cancel()
        heldLineDue = due
        guard let due else {
            heldLineSync = nil
            return
        }
        heldLineSync = Task { [weak self] in
            let wait = max(0, due.timeIntervalSinceNow)
            do { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) } catch { return }
            guard let self else { return }
            self.heldLineSync = nil
            self.heldLineDue = nil
            if let state = self.session?.state { self.sync(state) }
        }
    }
}

/// What the app actually holds.
///
/// `LiveActivityCoordinator` cannot exist below iOS 16.2, but the app's scene
/// does not want an `#available` around a stored property. The bridge owns the
/// coordinator where it is available and does nothing where it is not.
@MainActor
final class LiveActivityBridge {
    private var coordinator: AnyObject?

    func attach(to session: Session) {
        guard #available(iOS 16.2, *) else { return }
        // The scene's onAppear runs again after a language change. Re-attach
        // the coordinator already here, so its enablement loop is replaced
        // rather than orphaned and what the island shows is not resent.
        let coordinator = (self.coordinator as? LiveActivityCoordinator) ?? LiveActivityCoordinator()
        coordinator.attach(to: session)
        self.coordinator = coordinator
    }
}
