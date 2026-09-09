import SwiftUI
import CompanionCore

/// Separate contexts for either an agent or a channel. Keeping one sheet for
/// both makes "task" mean the same operation everywhere in the app.
struct TaskManagerView: View {
    let chat: Chat
    var onSelectThread: (String) -> Void = { _ in }
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var showingNewTask = false
    @State private var taskToRename: BotTask?
    @State private var title = ""

    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id)?.projected(forThread: bot.threadId).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first(where: { $0.id == room.id }).map(Chat.room) ?? chat
        }
    }

    private var tasks: [BotTask] {
        switch current {
        case let .bot(bot): return bot.tasks ?? []
        case let .room(room): return room.tasks ?? []
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        ChatAvatarView(chat: current, size: 48, state: .idle, animated: false)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.name).font(.headline)
                            Text(current.isBot ? "Agent threads" : "Group threads")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text("A thread is one conversation and result, with its own context and model.")
                }

                Section("Threads") {
                    ForEach(tasks, id: \.threadId) { task in
                        Button {
                            Task {
                                await switchTo(task)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    task.title.isEmpty ? Text("Untitled thread") : Text(verbatim: task.title)
                                        .foregroundStyle(Color.primary)
                                    Text(RelativeStamp.list(task.createdAt))
                                        .font(.caption)
                                        .foregroundStyle(Color.secondary)
                                    if let openedBy = task.openedByLabel {
                                        Text(verbatim: openedBy)
                                            .font(.caption)
                                            .foregroundStyle(Color.secondary)
                                    }
                                }
                                Spacer()
                                if task.threadId == current.threadId {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .contextMenu {
                            Button("Rename", systemImage: "pencil") {
                                title = task.title
                                taskToRename = task
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await delete(task) }
                            } label: { Label("Delete", systemImage: "trash") }
                            .disabled(tasks.count <= 1 || (current.isBot ? task.busy == true : current.busy))
                        }
                    }
                }
            }
            .navigationTitle("\(current.name)’s threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("New thread", systemImage: "plus") {
                        title = ""
                        showingNewTask = true
                    }
                    .disabled(!current.isBot && current.busy)
                }
            }
        }
        .alert("New thread", isPresented: $showingNewTask) {
            TextField("Title (optional)", text: $title)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task {
                    await create(title.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }
            }
        }
        .alert("Rename thread", isPresented: Binding(
            get: { taskToRename != nil },
            set: { if !$0 { taskToRename = nil } }
        )) {
            TextField("Title", text: $title)
            Button("Cancel", role: .cancel) { taskToRename = nil }
            Button("Save") {
                guard let task = taskToRename else { return }
                Task { await rename(task, title: title) }
                taskToRename = nil
            }
        }
    }

    private func create(_ title: String) async {
        switch current {
        case let .bot(bot):
            if let updated = await session.createTask(for: bot, title: title) {
                onSelectThread(updated.threadId)
                dismiss()
            }
        case let .room(room): await session.createTask(for: room, title: title)
        }
    }

    private func switchTo(_ task: BotTask) async {
        switch current {
        case let .bot(bot):
            if let updated = await session.switchTask(task, for: bot) { onSelectThread(updated.threadId) }
        case let .room(room): await session.switchTask(task, for: room)
        }
    }

    private func rename(_ task: BotTask, title: String) async {
        switch current {
        case let .bot(bot): await session.renameTask(task, for: bot, title: title)
        case let .room(room): await session.renameTask(task, for: room, title: title)
        }
    }

    private func delete(_ task: BotTask) async {
        switch current {
        case let .bot(bot):
            if let updated = await session.deleteTask(task, for: bot), task.threadId == bot.threadId {
                onSelectThread(updated.threadId)
                dismiss()
            }
        case let .room(room): await session.deleteTask(task, for: room)
        }
    }
}
