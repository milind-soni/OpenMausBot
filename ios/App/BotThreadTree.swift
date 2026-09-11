import CompanionCore
import SwiftUI

/// Observe search and live thread metadata here, independently of the
/// roster summary's stable bot identity.
struct BotThreadTree: View {
    let botID: String
    @Binding var query: String
    @Binding var expanded: Bool
    @Binding var collapsedFolders: Set<String>
    @Binding var creating: Bool
    let open: (Chat) -> Void
    let manage: (Chat) -> Void
    @EnvironmentObject private var session: Session

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        if let bot = session.state.bot(botID) {
            let isExpanded = searching || expanded
            let groups = bot.threadGroups(matching: bot.name.localizedCaseInsensitiveContains(query) ? "" : query)
            let count = bot.threadGroups().reduce(0) { $0 + $1.tasks.count }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Button {
                        Haptics.selection()
                        expanded.toggle()
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
                        Button { createThread(for: bot) } label: {
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

                if isExpanded {
                    ForEach(groups) { group in
                        if let folder = group.project {
                            DisclosureGroup(isExpanded: Binding(
                                get: { searching || !collapsedFolders.contains("\(botID):\(folder.id)") },
                                set: { value in
                                    let key = "\(botID):\(folder.id)"
                                    if value { collapsedFolders.remove(key) }
                                    else { collapsedFolders.insert(key) }
                                }
                            )) {
                                threadLinks(group.tasks, bot: bot).padding(.leading, 8)
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
                        } else {
                            threadLinks(group.tasks, bot: bot)
                        }
                    }
                }
            }
            .padding(.leading, 88)
            .padding(.trailing, 18)
            .padding(.bottom, isExpanded ? 12 : 0)
        }
    }

    private func threadLinks(_ tasks: [BotTask], bot: Bot) -> some View {
        ForEach(tasks, id: \.threadId) { task in
            if let projected = bot.projected(forThread: task.threadId) {
                NavigationLink(value: Chat.bot(projected)) {
                    BotThreadRow(task: task)
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("thread.\(task.threadId)")
            }
        }
    }

    private func createThread(for bot: Bot) {
        guard !creating else { return }
        creating = true
        Task {
            defer { creating = false }
            if let created = await session.createTask(for: bot, title: nil) {
                open(.bot(created))
            } else if session.actionError == nil {
                session.actionError = "Couldn't create a thread. Check the connection and try again."
            }
        }
    }
}
