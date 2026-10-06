import CompanionCore
import SwiftUI

/// A bot's "Threads" disclosure under its comfortable row.
///
/// It used to observe the whole session and sort the bot's threads twice on
/// every publish, for every bot. It now takes its bot and the queue state as
/// values and is Equatable on them, as `CompactBotEntry` is, so a publish
/// that did not move its bot skips it.
///
/// The list's own state (the search, which bots and folders are open, which
/// bot is making a thread) is read through bindings to that state, as
/// before: the tree follows every keystroke and tap even when the lazy list
/// does not rebuild its row. They are the list's `@State` projections, one
/// stable location each, not per-row `Binding(get:set:)`, which is a new
/// location on every render; and they are left out of `==`, since a change
/// to them redraws the tree through the binding itself.
struct BotThreadTree: View, Equatable {
    /// The bot as the state holds it now.
    let bot: Bot
    /// The roster search: a match lists the bot's threads.
    @Binding var query: String
    /// Bots whose thread list is open.
    @Binding var expandedBots: Set<String>
    /// Closed folders, keyed `botID:folderID`, for every bot.
    @Binding var collapsedFolders: Set<String>
    /// Bots a thread is being made for from the list.
    @Binding var creatingThreads: Set<String>
    /// `CompanionState.queuedThreadIds`: held sends keep a closed thread listed.
    let queuedThreadIds: Set<String>
    /// Threads holding at least one held send, for the rows' "Queued".
    let heldThreadIds: Set<String>
    /// For the tree's actions only; a plain reference is not observed.
    let session: Session
    let open: (Chat) -> Void
    let manage: (Chat) -> Void

    /// What the tree draws from values; see the type's note on the bindings.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.bot == rhs.bot && lhs.queuedThreadIds == rhs.queuedThreadIds
            && lhs.heldThreadIds == rhs.heldThreadIds && lhs.session === rhs.session
    }

    /// A timed snooze ends on the wall clock, not on a server ping: bump
    /// this when the nearest expiry passes so its row folds back in without
    /// waiting for the next snapshot. Mirrors the desktop's useSnoozeExpiry.
    @State private var snoozeTick = 0

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var creating: Bool { creatingThreads.contains(bot.id) }

    var body: some View {
        let _ = snoozeTick
        let isExpanded = searching || expandedBots.contains(bot.id)
        let matching = bot.name.localizedCaseInsensitiveContains(query) ? "" : query
        let groups = bot.threadGroups(matching: matching, queuedThreadIds: queuedThreadIds)
        // With nothing to match, the list is the whole tree: count it, not a second sort.
        let count = matching.isEmpty
            ? groups.reduce(0) { $0 + $1.tasks.count }
            : bot.rosterThreadCount(queuedThreadIds: queuedThreadIds)
        let nextSnoozeExpiry = bot.visibleTasks.nextSnoozeExpiry()
        VStack(alignment: .leading, spacing: 0) {
            header(isExpanded: isExpanded, count: count)
            if isExpanded {
                ForEach(groups) { group in
                    if let folder = group.project {
                        folderGroup(folder, tasks: group.tasks)
                    } else {
                        threadLinks(group.tasks)
                    }
                }
            }
        }
        .padding(.leading, 88)
        .padding(.trailing, 18)
        .padding(.bottom, isExpanded ? 12 : 0)
        .snoozeExpiryTick(nextSnoozeExpiry, tick: $snoozeTick)
    }

    private func header(isExpanded: Bool, count: Int) -> some View {
        HStack(spacing: 8) {
            Button {
                Haptics.selection()
                if expandedBots.contains(bot.id) { expandedBots.remove(bot.id) } else { expandedBots.insert(bot.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Threads")
                    Text("\(count)").foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 13, weight: .medium))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(bot.name)'s threads")
            .accessibilityValue(isExpanded ? "Expanded, \(count) threads" : "Collapsed, \(count) threads")
            .accessibilityIdentifier("threads-toggle.\(bot.id)")
            .disabled(searching)

            if isExpanded {
                Button { createThread() } label: {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }
                .disabled(creating)
                .accessibilityLabel("New thread with \(bot.name)")
                Button { manage(.bot(bot)) } label: {
                    Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Manage \(bot.name)'s threads")
            }
        }
        .foregroundStyle(.secondary)
    }

    private func folderGroup(_ folder: BotProject, tasks: [BotTask]) -> some View {
        let key = "\(bot.id):\(folder.id)"
        return DisclosureGroup(isExpanded: Binding(
            get: { searching || !collapsedFolders.contains(key) },
            set: { value in
                if value { collapsedFolders.remove(key) } else { collapsedFolders.insert(key) }
            }
        )) {
            threadLinks(tasks).padding(.leading, 8)
        } label: {
            HStack(spacing: 6) {
                if let emoji = folder.emoji, !emoji.isEmpty { Text(emoji) }
                else { Image(systemName: "folder") }
                Text(folder.name).lineLimit(1)
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(minHeight: 40)
        }
    }

    private func threadLinks(_ tasks: [BotTask]) -> some View {
        ForEach(tasks, id: \.threadId) { task in
            if let projected = bot.projected(forThread: task.threadId) {
                NavigationLink(value: Chat.bot(projected)) {
                    BotThreadRow(task: task, queued: heldThreadIds.contains(task.threadId))
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
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

    private func createThread() {
        guard creatingThreads.insert(bot.id).inserted else { return }
        Task {
            defer { creatingThreads.remove(bot.id) }
            if let created = await session.createRosterThread(for: bot) {
                open(.bot(created))
            }
        }
    }
}

extension Session {
    /// A new thread started from the home list, in either density. A
    /// failure always says something, even when the client had no error.
    func createRosterThread(for bot: Bot) async -> Bot? {
        if let created = await createTask(for: bot, title: nil) { return created }
        if actionError == nil {
            actionError = "Couldn't create a thread. Check the connection and try again."
        }
        return nil
    }
}

extension View {
    /// A timed snooze ends on the wall clock, not on a server ping: bump
    /// `tick` when the nearest expiry passes so a view reading the thread
    /// list folds that thread back in without waiting for the next snapshot.
    /// Mirrors the desktop's useSnoozeExpiry.
    func snoozeExpiryTick(_ nextExpiry: Double?, tick: Binding<Int>) -> some View {
        task(id: "\(nextExpiry ?? 0):\(tick.wrappedValue)") {
            guard let nextExpiry else { return }
            let seconds = max(0, (nextExpiry - Date().timeIntervalSince1970 * 1_000) / 1_000) + 0.05
            // Remote deadlines can be arbitrarily distant. Bound the
            // duration conversion and re-arm with the tick until due.
            try? await Task.sleep(for: .seconds(min(86_400, seconds)))
            guard !Task.isCancelled else { return }
            tick.wrappedValue += 1
        }
    }
}
