// How much each row on the home list says.
//
// The phone follows the desktop sidebar's density setting
// (`src/lib/sidebar-preferences.ts`) without its avatars-only mode, which a
// phone has no room to need. Comfortable is the original two-line row with a
// "Threads" disclosure beneath every bot; compact is one line per bot, status
// as small marks, and a thread list only where there is one to open.
//
// The decisions live here, away from SwiftUI, so both densities read the
// same facts and the rules can be tested without a screen.
import Foundation

public enum RosterDensity: String, CaseIterable, Codable, Sendable {
    case comfortable
    case compact

    /// What a new install shows.
    public static let `default`: RosterDensity = .compact

    /// A stored choice, read defensively: anything unreadable — including
    /// the desktop's "icons" — lands on the default rather than a surprise.
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

/// Everything one bot's row decides, as data.
public struct RosterBotRow: Equatable, Sendable {
    public let density: RosterDensity
    public let status: RosterRowStatus
    /// Threads behind the compact "› N" control.
    public let threadCount: Int
    public let isChief: Bool
    public let unread: Bool

    public init(
        bot: Bot,
        density: RosterDensity,
        hasPendingCard: Bool,
        queuedThreadIds: Set<String> = []
    ) {
        self.density = density
        status = bot.rosterStatus(hasPendingCard: hasPendingCard)
        threadCount = bot.rosterThreadCount(queuedThreadIds: queuedThreadIds)
        isChief = bot.chiefOfStaff == true
        unread = bot.unread
    }

    /// Compact is one line: no last-message preview.
    public var showsPreview: Bool { density == .comfortable }

    /// Comfortable keeps its "Threads N" disclosure beneath every bot.
    public var showsThreadsRow: Bool { density == .comfortable }

    /// Compact gives the "› N" control only to a bot with a list to open.
    /// One thread is the bot itself: tapping the row already opens it.
    public var showsThreadControl: Bool { density == .compact && threadCount >= 2 }

    /// The Chief of Staff crown after the name. Comfortable keeps the look
    /// it shipped with.
    public var showsChiefBadge: Bool { density == .compact && isChief }

    /// Compact rows put the spinner where the time was.
    public var showsTime: Bool { !(density == .compact && status == .working) }

    public var showsSpinner: Bool { status == .working }

    public var showsWaiting: Bool { status == .waitingOnYou }

    /// As it always was: the dot steps aside while the bot works.
    public var showsUnreadDot: Bool { unread && status != .working }

    /// Whether the bot's threads are listed beneath its row. A search lists
    /// what matched under every bot, as the desktop does; otherwise compact
    /// lists only a bot the person opened with its "› N" control.
    public func listsThreads(expanded: Bool, searching: Bool) -> Bool {
        switch density {
        case .comfortable: searching || expanded
        case .compact: searching || (expanded && showsThreadControl)
        }
    }

    /// A compact list the person opened ends with "+ New thread". Search
    /// results are not a place to create one, and comfortable keeps its "+"
    /// on the "Threads" row.
    public func endsWithNewThread(expanded: Bool, searching: Bool) -> Bool {
        density == .compact && !searching && expanded && showsThreadControl
    }
}
