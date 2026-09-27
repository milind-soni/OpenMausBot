// How much each row on the home list says.
//
// Like the desktop sidebar's density setting
// (`src/lib/sidebar-preferences.ts`), without its avatars-only mode, which a
// phone has no room to need, and stored per device. Unlike the desktop, a
// new install starts compact. Comfortable is the original two-line row with
// a "Threads" disclosure beneath every bot; compact is one line per bot,
// status as small marks, and a thread list only where there is one to open.
//
// Compact's row decisions live here, away from SwiftUI, so they can be tested
// without a screen. Comfortable rows keep their original logic in the app's
// `ChatRow` and `BotThreadTree`.
import Foundation

public enum RosterDensity: String, CaseIterable, Codable, Sendable {
    case comfortable
    case compact

    /// What a new install shows.
    public static let `default`: RosterDensity = .compact

    /// A stored choice, read defensively: anything this build cannot read —
    /// a density a later version adds, or a damaged store — lands on the
    /// default rather than a surprise.
    public init(stored: String?) {
        self = stored.flatMap(RosterDensity.init(rawValue:)) ?? .default
    }

    public var label: String {
        switch self {
        case .comfortable: "Comfortable"
        case .compact: "Compact"
        }
    }

    public var caption: String {
        switch self {
        case .comfortable: "Larger faces, with each bot’s latest message under its name."
        case .compact: "One line per bot. Bots with more than one thread show how many; tap the number to list them."
        }
    }
}

/// The one live signal a bot's row carries, most urgent first — the
/// desktop row's order.
public enum RosterRowStatus: Equatable, Sendable {
    /// Nothing is happening: the row shows when the bot last spoke.
    case idle
    /// A thread is mid-turn.
    case working
    /// The bot stopped for the person. Outranks work: the harness counts a
    /// wait on the person as busy, and the person is who the row is for.
    case waitingOnYou
}

extension Bot {
    /// The threads the home list would show for this bot when it is opened:
    /// the same fold as the thread tree, so the count never disagrees with
    /// the list it opens. Routine runs and put-away threads stay out.
    public func rosterThreadCount(queuedThreadIds: Set<String> = []) -> Int {
        threadGroups(queuedThreadIds: queuedThreadIds).reduce(0) { $0 + $1.tasks.count }
    }

    /// Read from every visible thread, not just the one open on the desktop,
    /// so a bot working in the background still shows it.
    /// - Parameter hasPendingCard: an unanswered approval or question sits in
    ///   one of this bot's threads. Cards live in transcripts, which the bot
    ///   record does not carry.
    public func rosterStatus(hasPendingCard: Bool) -> RosterRowStatus {
        let threads = visibleTasks
        if hasPendingCard || threads.contains(where: { $0.activity == "waiting-on-you" }) {
            return .waitingOnYou
        }
        // A teammate wait is painted busy on the wire; the flag alone
        // decides that it is a quiet wait, never the work spinner.
        let botWorks = busy == true && waitingOnTeammate != true
        if botWorks || threads.contains(where: { $0.isWorking && !$0.isWaitingOnTeammate }) {
            return .working
        }
        return .idle
    }
}

/// What one bot's line in the compact list shows, as data.
public struct CompactBotRow: Equatable, Sendable {
    public let status: RosterRowStatus
    /// Threads behind the "› N" control.
    public let threadCount: Int
    /// The Chief of Staff crown after the name.
    public let showsChiefBadge: Bool
    /// The comfortable row's rule, exactly: the bot's own unread flag,
    /// hidden while its conversation is busy — which the harness also
    /// reports while the bot waits on the person or on a teammate.
    public let showsUnreadDot: Bool

    public init(bot: Bot, hasPendingCard: Bool, queuedThreadIds: Set<String> = []) {
        status = bot.rosterStatus(hasPendingCard: hasPendingCard)
        threadCount = bot.rosterThreadCount(queuedThreadIds: queuedThreadIds)
        showsChiefBadge = bot.chiefOfStaff == true
        showsUnreadDot = bot.unread && bot.busy != true
    }

    /// Only a bot with a list to open gets "› N". One thread is the bot
    /// itself: tapping the row already opens it.
    public var showsThreadControl: Bool { threadCount >= 2 }

    /// The spinner stands where the time was.
    public var showsTime: Bool { status != .working }

    public var showsSpinner: Bool { status == .working }

    public var showsWaiting: Bool { status == .waitingOnYou }

    /// Whether the bot's threads are listed beneath its row. A search lists
    /// what matched under every bot, as the desktop does; otherwise only a
    /// bot the person opened with its "› N" control.
    public func listsThreads(expanded: Bool, searching: Bool) -> Bool {
        searching || (expanded && showsThreadControl)
    }

    /// A list the person opened ends with "+ New thread". Search results
    /// are not a place to create one.
    public func endsWithNewThread(expanded: Bool, searching: Bool) -> Bool {
        !searching && expanded && showsThreadControl
    }
}
