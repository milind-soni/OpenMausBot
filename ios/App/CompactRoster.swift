// The compact home list: one line per bot and per group.
//
// The phone's version of the desktop sidebar's compact density: name, role
// and status on one line, a crown after a Chief of Staff's name, and a
// thread list only under a bot that has more than one thread — opened from
// its "› N" control and lined up with the bot's name. What each row shows
// is decided in CompanionCore's `CompactBotRow`; this file is layout.
import SwiftUI
import CompanionCore

/// Rhythm shared by bot rows, group rows and the thread lines beneath a
/// bot, so a thread starts exactly where its bot's name does.
enum CompactRosterMetrics {
    /// Before the unread-dot gutter: with the gutter, faces start on the
    /// section titles' 20pt edge.
    static let leading: CGFloat = 4
    static let dotGutter: CGFloat = 16
    static let faceSpacing: CGFloat = 10
    static let trailing: CGFloat = 16
    /// The face, before Dynamic Type scales it.
    static let face: CGFloat = 26
    /// Scaled faces stop growing here, so the largest text sizes spend
    /// their width on names rather than on pictures.
    static let maxFace: CGFloat = 40
    /// Above and below a row's content on one line; see `RowPadding`.
    static let rowPadding: CGFloat = 4
    /// What sits beneath a name at the accessibility sizes: a bot's time
    /// and role, a group's time. Well below the name's body and the
    /// one-line row's subheadline, so the name reads first.
    static let stackedDetail: Font = .footnote

    static func nameInset(face: CGFloat) -> CGFloat {
        leading + dotGutter + face + faceSpacing
    }
}

/// One bot on one line, with its threads beneath it when opened.
struct CompactBotEntry: View {
    let bot: Bot
    /// When the bot's current thread last moved, from the roster summary.
    let lastActivity: Double
    /// An unanswered approval or question sits in one of its threads.
    let hasPendingCard: Bool
    @Binding var query: String
    @Binding var expanded: Bool
    @Binding var collapsedFolders: Set<String>
    @Binding var creating: Bool
    /// The row itself: the bot's last-opened thread, as before.
    let openRow: () -> Void
    /// An exact thread, or one just created.
    let open: (Chat) -> Void
    let manage: (Chat) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var scaledFace = CompactRosterMetrics.face
    /// Wakes the list when a timed snooze ends, so the count and the list
    /// fold that thread back in without waiting for a snapshot.
    @State private var snoozeTick = 0

    private var face: CGFloat { min(scaledFace, CompactRosterMetrics.maxFace) }

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        let _ = snoozeTick
        let live = session.state.bot(bot.id) ?? bot
        let queued = session.state.queuedThreadIds
        let row = CompactBotRow(
            bot: live, hasPendingCard: hasPendingCard, queuedThreadIds: queued, creatingThread: creating
        )
        VStack(alignment: .leading, spacing: 0) {
            rowLine(live, row)
            if row.listsThreads(expanded: expanded, searching: searching) {
                threadList(live, row: row, queued: queued)
            }
        }
        .snoozeExpiryTick(live.visibleTasks.nextSnoozeExpiry(), tick: $snoozeTick)
        // A list opened with "› N" closes when the control goes away (the
        // bot is down to one thread), so it cannot reopen by itself when the
        // bot gains a thread again. Also clears a stale open state carried
        // over from comfortable, where every bot has a Threads row.
        .onValueChange(of: row.showsThreadControl, initial: true) { shows in
            if !shows && expanded { expanded = false }
        }
    }

    // MARK: - The bot's line

    private func rowLine(_ bot: Bot, _ row: CompactBotRow) -> some View {
        HStack(spacing: 0) {
            Button(action: openRow) {
                HStack(spacing: 0) {
                    UnreadDot(visible: row.showsUnreadDot, color: bot.color)
                    BotAvatarView(
                        bot: bot, size: face,
                        state: MausState.forChat(.bot(bot), in: session.state),
                        animated: false
                    )
                    .accessibilityHidden(true)
                    .padding(.trailing, CompactRosterMetrics.faceSpacing)

                    // the spinner also stands for a thread being made
                    let spinnerLabel: LocalizedStringKey = row.status == .working ? "Working" : "Creating…"
                    if typeSize.isAccessibilitySize {
                        // One line cannot hold a name and a time at these
                        // sizes: the name gets the whole width, whole words
                        // intact, and the time and role move beneath it,
                        // a size smaller so the name reads first.
                        VStack(alignment: .leading, spacing: 2) {
                            name(bot, row)
                            let line = row.secondLine(stamp: RelativeStamp.list(lastActivity), role: bot.title)
                            if !line.isEmpty {
                                SecondLine(line: line, color: bot.color, spinnerLabel: spinnerLabel)
                            }
                        }
                        Spacer(minLength: 0)
                    } else {
                        nameAndRole(bot, row)
                        Spacer(minLength: 8)
                        RowStatus(
                            waiting: row.showsWaiting, working: row.showsSpinner,
                            stamp: row.showsTime ? RelativeStamp.list(lastActivity) : "",
                            color: bot.color, spinnerLabel: spinnerLabel
                        )
                    }
                }
                .padding(.leading, CompactRosterMetrics.leading)
                .padding(.trailing, row.showsThreadControl ? 0 : CompactRosterMetrics.trailing)
                .modifier(RowPadding())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                // A single-thread bot shows no thread list to end in "New
                // thread", so the home list offers it here — for every bot.
                Button { createThread(for: bot) } label: {
                    Label("New thread", systemImage: "square.and.pencil")
                }
                .disabled(creating)
                Button { manage(.bot(bot)) } label: {
                    Label("Manage threads", systemImage: "list.bullet")
                }
            }
            .accessibilityIdentifier("chat-row.\(bot.id)")

            if row.showsThreadControl {
                threadControl(bot, count: row.threadCount)
                    // the control's own padding lands its glyph on the
                    // 16pt edge that times in other rows end on
                    .padding(.trailing, CompactRosterMetrics.trailing - 10)
            }
        }
    }

    /// Name first: the role takes what is left and truncates, and when too
    /// little is left for a word of it the role steps aside rather than
    /// showing a sliver. At the accessibility text sizes the name wraps
    /// rather than clips.
    private func nameAndRole(_ bot: Bot, _ row: CompactBotRow) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                // Laid out first, so the role takes only what the name
                // leaves rather than an equal share of the line.
                name(bot, row)
                    .layoutPriority(1)
                if !bot.title.isEmpty {
                    Text(verbatim: bot.title)
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        // Measured at its minimum, so this line is chosen
                        // whenever the name fits with room for a word of role.
                        .frame(minWidth: 40, idealWidth: 40, maxWidth: .infinity, alignment: .leading)
                }
            }
            name(bot, row)
        }
    }

    private func name(_ bot: Bot, _ row: CompactBotRow) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: bot.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.primary)
                .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                .fixedSize(horizontal: false, vertical: true)
            if row.showsChiefBadge {
                ChiefBadge()
            }
        }
    }

    /// "› N": the bot's threads, opened in place.
    private func threadControl(_ bot: Bot, count: Int) -> some View {
        let listed = searching || expanded
        return Button {
            Haptics.selection()
            withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(listed ? 90 : 0))
                Text("\(count)")
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
            }
            .foregroundStyle(Color.secondary)
            .padding(.horizontal, 10)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(searching)
        .accessibilityLabel("\(bot.name)'s threads")
        .accessibilityValue(listed ? "Expanded, \(count) threads" : "Collapsed, \(count) threads")
        .accessibilityIdentifier("threads-toggle.\(bot.id)")
    }

    // MARK: - The threads beneath it

    private func threadList(_ bot: Bot, row: CompactBotRow, queued: Set<String>) -> some View {
        // A name match lists everything; otherwise only what matched.
        let groups = bot.threadGroups(
            matching: bot.name.localizedCaseInsensitiveContains(query) ? "" : query,
            queuedThreadIds: queued
        )
        let labelsUnfiled = groups.labelsUnfiledThreads
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(groups) { group in
                if let folder = group.project {
                    folderHeader(folder)
                    if searching || !collapsedFolders.contains(folderKey(folder)) {
                        threadLines(group.tasks, bot: bot)
                    }
                } else {
                    if labelsUnfiled {
                        unfiledLabel(bot)
                    }
                    threadLines(group.tasks, bot: bot)
                }
            }
            if row.endsWithNewThread(expanded: expanded, searching: searching) {
                newThreadLine(bot)
            }
        }
        .padding(.leading, CompactRosterMetrics.nameInset(face: face))
        .padding(.trailing, CompactRosterMetrics.trailing)
        .padding(.bottom, 4)
    }

    private func folderKey(_ folder: BotProject) -> String { "\(bot.id):\(folder.id)" }

    private func folderHeader(_ folder: BotProject) -> some View {
        let open = searching || !collapsedFolders.contains(folderKey(folder))
        return Button {
            let key = folderKey(folder)
            if collapsedFolders.contains(key) { collapsedFolders.remove(key) } else { collapsedFolders.insert(key) }
        } label: {
            HStack(spacing: 6) {
                if let emoji = folder.emoji, !emoji.isEmpty {
                    Text(verbatim: emoji)
                } else {
                    Image(systemName: "folder")
                }
                Text(verbatim: folder.name)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                Spacer(minLength: 0)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.secondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(searching)
        .accessibilityLabel(Text(verbatim: folder.name))
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("folder.\(bot.id).\(folder.id)")
    }

    /// Unfiled threads start on the same edge as a folder's, so after a
    /// folder they need a label of their own — the desktop's "Threads".
    private func unfiledLabel(_ bot: Bot) -> some View {
        Text("Threads")
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.secondary)
            .padding(.top, 10)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("unfiled-threads.\(bot.id)")
    }

    private func threadLines(_ tasks: [BotTask], bot: Bot) -> some View {
        ForEach(tasks, id: \.threadId) { task in
            if let projected = bot.projected(forThread: task.threadId) {
                NavigationLink(value: Chat.bot(projected)) {
                    CompactThreadLine(
                        task: task,
                        queued: session.state.pendingQueued[task.threadId]?.isEmpty == false
                    )
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button {
                        let pinned = task.pinned != true
                        Task { await session.setTaskPinned(task, pinned: pinned, in: .bot(bot)) }
                    } label: {
                        Label(task.pinned == true ? "Unpin" : "Pin", systemImage: task.pinned == true ? "pin.slash" : "pin")
                    }
                }
                .accessibilityIdentifier("thread.\(task.threadId)")
            }
        }
    }

    private func newThreadLine(_ bot: Bot) -> some View {
        Button { createThread(for: bot) } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                    .font(.footnote.weight(.semibold))
                Text("New thread")
                if creating {
                    ProgressView().controlSize(.small)
                }
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.accentColor)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(creating)
        .accessibilityLabel("New thread with \(bot.name)")
        .accessibilityIdentifier("new-thread.\(bot.id)")
    }

    private func createThread(for bot: Bot) {
        guard !creating else { return }
        creating = true
        Task {
            defer { creating = false }
            if let created = await session.createRosterThread(for: bot) {
                open(.bot(created))
            }
        }
    }
}

/// One thread under its bot: title, then its status and when it last moved.
struct CompactThreadLine: View {
    let task: BotTask
    /// A held send, from the client's queue state (never in `activity`).
    var queued = false

    @Environment(\.dynamicTypeSize) private var typeSize

    private enum Mark {
        case waitingOnYou, waitingOnTeammate, working, queued

        var words: LocalizedStringKey {
            switch self {
            case .waitingOnYou: "Waiting on you"
            case .waitingOnTeammate: "Waiting on teammate"
            case .working: "Working"
            case .queued: "Queued"
            }
        }
    }

    /// Ordered as `BotThreadRow` orders it: the person, a teammate wait
    /// (a quiet clock, never a spinner), work, then a held send.
    private var mark: Mark? {
        if task.activity == "waiting-on-you" { return .waitingOnYou }
        if task.isWaitingOnTeammate { return .waitingOnTeammate }
        if task.isWorking { return .working }
        if task.activity == "queued" || queued { return .queued }
        return nil
    }

    private var dimmed: Bool {
        (task.isClosed || task.isArchived) && mark == nil && task.unread != true
    }

    private var stamp: String { RelativeStamp.list(task.listStamp) }

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // the title gets the whole width; its marks and time follow
                VStack(alignment: .leading, spacing: 2) {
                    title.lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    marks
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 6) {
                    title.lineLimit(1).layoutPriority(1)
                    Spacer(minLength: 8)
                    marks
                }
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityValue(task.isArchived ? "Archived" : dimmed ? "Closed" : "")
    }

    private var title: some View {
        HStack(spacing: 6) {
            Text(verbatim: task.displayTitle)
                .font(.subheadline.weight(task.unread == true ? .semibold : .regular))
                .foregroundStyle(dimmed ? Color.secondary : Color.primary)
            if task.pinned == true {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.secondary)
            }
        }
    }

    /// Unread, then the live mark, then the time — or the spinner in its place.
    private var marks: some View {
        HStack(spacing: 6) {
            if task.unread == true {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
            }
            switch mark {
            case .waitingOnYou:
                Image(systemName: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Color.orange)
            case .waitingOnTeammate, .queued:
                Image(systemName: "clock")
                    .font(.caption)
                    .foregroundStyle(Color.secondary)
            case .working, nil:
                EmptyView()
            }
            if mark == .working {
                // the spinner stands where the time was, as on the bot's line
                ProgressView().controlSize(.small)
            } else if !stamp.isEmpty {
                Text(verbatim: stamp)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
            }
        }
        .fixedSize()
    }

    private var accessibilitySummary: Text {
        var parts = [Text(verbatim: task.displayTitle)]
        if let mark { parts.append(Text(mark.words)) }
        if task.unread == true { parts.append(Text("Unread")) }
        if task.pinned == true { parts.append(Text("Pinned")) }
        if !stamp.isEmpty { parts.append(Text(verbatim: stamp)) }
        return parts.dropFirst().reduce(parts[0]) { $0 + Text(verbatim: ", ") + $1 }
    }
}

/// A group on one line: two of its members' faces, overlapping, then its name.
struct CompactRoomRow: View {
    let room: Room
    let lastActivity: Double
    /// An unanswered approval or question sits in the group's thread.
    var waiting = false

    @EnvironmentObject private var session: Session
    @ScaledMetric(relativeTo: .body) private var scaledFace = CompactRosterMetrics.face
    @Environment(\.dynamicTypeSize) private var typeSize

    private var face: CGFloat { min(scaledFace, CompactRosterMetrics.maxFace) }
    private var busy: Bool { room.busyBotId != nil }

    var body: some View {
        HStack(spacing: 0) {
            UnreadDot(visible: room.unread && !busy, color: "blue")
            RoomFaces(members: room.memberIds.compactMap { session.state.bot($0) }, size: face)
                .accessibilityHidden(true)
                .padding(.trailing, CompactRosterMetrics.faceSpacing)
            let name = Text(verbatim: room.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.primary)
            let status = RowStatus(
                waiting: waiting, working: busy,
                stamp: busy ? "" : RelativeStamp.list(lastActivity),
                color: "blue",
                stampFont: typeSize.isAccessibilitySize ? CompactRosterMetrics.stackedDetail : .subheadline
            )
            if typeSize.isAccessibilitySize {
                // as on a bot's row: the whole width for the name, and the
                // time a size smaller beneath it
                VStack(alignment: .leading, spacing: 2) {
                    name
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                    status
                }
                Spacer(minLength: 0)
            } else {
                name.lineLimit(1)
                Spacer(minLength: 8)
                status
            }
        }
        .padding(.leading, CompactRosterMetrics.leading)
        .padding(.trailing, CompactRosterMetrics.trailing)
        .modifier(RowPadding())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// A row's air above and below. On one line it is 4pt, and the 44pt row
/// height does the rest; once a row stacks its name over its time, at the
/// accessibility sizes, it grows with the text, so one row's time does not
/// run into the next row's name.
private struct RowPadding: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var stacked = CompactRosterMetrics.rowPadding

    func body(content: Content) -> some View {
        content.padding(.vertical, typeSize.isAccessibilitySize ? stacked : CompactRosterMetrics.rowPadding)
    }
}

/// Beneath a bot's name at the accessibility sizes: the hand or the spinner,
/// then the time and the role as one quiet line that gives way at its end.
private struct SecondLine: View {
    let line: CompactSecondLine
    let color: String
    let spinnerLabel: LocalizedStringKey

    var body: some View {
        HStack(spacing: 6) {
            if line.showsWaiting || line.showsSpinner {
                RowStatus(
                    waiting: line.showsWaiting, working: line.showsSpinner, stamp: "",
                    color: color, spinnerLabel: spinnerLabel
                )
            }
            if !line.words.isEmpty {
                Text(verbatim: line.text)
                    .font(CompactRosterMetrics.stackedDetail)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    .accessibilityLabel(Text(verbatim: line.spokenText))
            }
        }
    }
}

/// Two members' faces in one face's square: the first up and left, the
/// second down and right on a ring of the list's background.
private struct RoomFaces: View {
    let members: [Bot]
    let size: CGFloat

    var body: some View {
        ZStack {
            if let first = members.first {
                BotAvatarView(bot: first, size: size * 0.74, state: .happy, animated: false)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                MausAvatar(color: "blue", size: size, state: .happy, animated: false)
            }
            if members.count > 1 {
                BotAvatarView(bot: members[1], size: size * 0.62, state: .happy, animated: false)
                    .padding(1.5)
                    .background(Circle().fill(Color(uiColor: .systemBackground)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .offset(x: 3, y: 3)
            }
        }
        .frame(width: size, height: size)
    }
}

/// The unread dot, in its own gutter at the row's leading edge, as on the
/// comfortable rows.
private struct UnreadDot: View {
    let visible: Bool
    let color: String

    var body: some View {
        ZStack {
            if visible {
                Circle()
                    .fill(MausPalette.color(color))
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Unread")
            }
        }
        .frame(width: CompactRosterMetrics.dotGutter)
    }
}

/// The trailing marks: a hand in the chat's colour while it waits on the
/// person, and a spinner in place of the time while it works.
private struct RowStatus: View {
    let waiting: Bool
    let working: Bool
    let stamp: String
    let color: String
    /// What VoiceOver calls the spinner.
    var spinnerLabel: LocalizedStringKey = "Working"
    /// The time's size: subheadline beside the name on one line, smaller
    /// beneath it.
    var stampFont: Font = .subheadline

    var body: some View {
        HStack(spacing: 6) {
            if waiting {
                Image(systemName: "hand.raised.fill")
                    .font(.footnote)
                    .foregroundStyle(MausPalette.color(color))
                    .accessibilityLabel("Waiting on you")
            }
            if working {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(spinnerLabel)
            } else if !stamp.isEmpty {
                Text(verbatim: stamp)
                    .font(stampFont)
                    .foregroundStyle(Color.secondary)
            }
        }
        .fixedSize()
    }
}

/// The Chief of Staff mark after a bot's name: the desktop's crown. It
/// scales with the name, so it keeps its default proportion to it at every
/// text size instead of outgrowing it at the largest ones.
struct ChiefBadge: View {
    /// Caption's size at the default text size, scaled as the name's body is.
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 12

    var body: some View {
        Image(systemName: "crown.fill")
            .font(.system(size: size))
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Chief of Staff")
            .accessibilityIdentifier("chief-badge")
    }
}
