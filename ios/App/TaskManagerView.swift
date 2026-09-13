import SwiftUI
import CompanionCore

/// Bot thread selection belongs to this phone. Group threads retain their
/// shared, serial selection on the paired computer.
struct TaskManagerView: View {
    let chat: Chat
    var onSelectThread: (String) -> Void = { _ in }
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var taskToRename: BotTask?
    @State private var taskToDelete: BotTask?
    @State private var title = ""
    @State private var isMutating = false
    @State private var errorMessage: String?
    @FocusState private var renameFocused: Bool

    private var current: Chat {
        switch chat {
        case let .bot(bot):
            guard let live = session.state.bot(bot.id) else { return chat }
            return .bot(live.projected(forThread: bot.threadId) ?? live)
        case let .room(room):
            return session.state.rooms.first(where: { $0.id == room.id }).map(Chat.room) ?? chat
        }
    }

    private var tasks: [BotTask] {
        switch current {
        case let .bot(bot): return bot.threadGroups(includingClosed: true).flatMap(\.tasks)
        case let .room(room): return room.tasks ?? []
        }
    }

    private var matchingRoomTasks: [BotTask] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return tasks.filter { query.isEmpty || $0.displayTitle.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let taskToRename {
                    Section("Rename thread") {
                        TextField("Thread title", text: $title)
                            .focused($renameFocused)
                            .submitLabel(.done)
                            .onSubmit { saveRename(taskToRename) }
                            .disabled(isMutating)
                        HStack {
                            Button("Cancel", role: .cancel) {
                                self.taskToRename = nil
                                renameFocused = false
                            }
                            Spacer()
                            Button("Save") { saveRename(taskToRename) }
                                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        .buttonStyle(.borderless)
                        .disabled(isMutating)
                    }
                }

                threadSections
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(.regularMaterial)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("thread-action-error")
                }
            }
            .searchable(text: $search, prompt: current.isBot ? "Search threads and folders" : "Search threads")
            .navigationTitle("\(current.name)’s threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.disabled(isMutating)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("New thread", systemImage: "plus") {
                        perform { await create() }
                    }
                    .disabled(isMutating || (!current.isBot && current.busy))
                    .accessibilityIdentifier("new-thread")
                }
            }
            .overlay(alignment: .bottom) {
                if isMutating {
                    ProgressView("Updating threads…")
                        .padding(12)
                        .background(.regularMaterial, in: Capsule())
                        .padding()
                }
            }
        }
        .interactiveDismissDisabled(isMutating)
        .confirmationDialog("Delete thread?", isPresented: Binding(
            get: { taskToDelete != nil },
            set: { if !$0 { taskToDelete = nil } }
        ), titleVisibility: .visible) {
            if let task = taskToDelete {
                Button("Delete thread", role: .destructive) {
                    taskToDelete = nil
                    perform { await delete(task) }
                }
            }
            Button("Cancel", role: .cancel) { taskToDelete = nil }
        } message: {
            if let task = taskToDelete {
                Text("Delete “\(task.displayTitle)” and its conversation? This cannot be undone.")
            }
        }
    }

    @ViewBuilder private var threadSections: some View {
        switch current {
        case let .bot(bot):
            // The manage sheet is the "all threads" surface: closed ones
            // are listed here, dimmed, so nothing a bot tidied is lost.
            let groups = bot.threadGroups(matching: search, includingClosed: true)
            if groups.isEmpty {
                emptySearch
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.tasks, id: \.threadId) { task in
                            threadButton(task)
                        }
                        if group.tasks.isEmpty {
                            Text("No threads in this folder")
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        if let project = group.project {
                            HStack(spacing: 5) {
                                if let emoji = project.emoji, !emoji.isEmpty {
                                    Text(verbatim: emoji)
                                } else {
                                    Image(systemName: "folder")
                                }
                                Text(verbatim: project.name)
                            }
                        } else {
                            Text(bot.projects?.isEmpty == false ? "Unfiled" : "Threads")
                        }
                    }
                }
            }
        case .room:
            Section {
                if matchingRoomTasks.isEmpty {
                    emptySearch
                } else {
                    ForEach(matchingRoomTasks, id: \.threadId) { task in
                        threadButton(task)
                    }
                }
            } header: {
                Text("Threads")
            } footer: {
                if current.busy {
                    Text("You can switch or create a group thread when the current reply finishes.")
                }
            }
        }
    }

    private var emptySearch: some View {
        ContentUnavailableView.search(text: search)
    }

    private func threadButton(_ task: BotTask) -> some View {
        Button {
            perform { await switchTo(task) }
        } label: {
            BotThreadRow(task: task, selected: task.threadId == current.threadId)
        }
        .disabled(isMutating || (!current.isBot && current.busy && task.threadId != current.threadId))
        .accessibilityIdentifier("thread-\(task.threadId)")
        .contextMenu {
            Button("Rename", systemImage: "pencil") { beginRename(task) }
                .disabled(isMutating)
            Button("Delete", systemImage: "trash", role: .destructive) { taskToDelete = task }
                .disabled(!canDelete(task))
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { taskToDelete = task } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(!canDelete(task))
            Button { beginRename(task) } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(.accentColor)
            .disabled(isMutating)
        }
    }

    private func canDelete(_ task: BotTask) -> Bool {
        !isMutating && tasks.count > 1 && (current.isBot ? task.busy != true : !current.busy)
    }

    private func beginRename(_ task: BotTask) {
        title = task.title
        taskToRename = task
        errorMessage = nil
        renameFocused = true
    }

    private func saveRename(_ task: BotTask) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        perform { await rename(task, title: trimmed) }
    }

    /// Lock before creating the Task so two rapid taps cannot send two writes.
    private func perform(_ operation: @escaping @MainActor () async -> Void) {
        guard !isMutating else { return }
        isMutating = true
        errorMessage = nil
        session.actionError = nil
        Task { @MainActor in
            await operation()
            isMutating = false
        }
    }

    private func showError(_ fallback: String) {
        errorMessage = session.actionError ?? fallback
        session.actionError = nil
    }

    private func create() async {
        switch current {
        case let .bot(bot):
            guard let updated = await session.createTask(for: bot, title: nil) else {
                showError("Couldn't create the thread. Try again.")
                return
            }
            onSelectThread(updated.threadId)
        case let .room(room):
            guard room.busyBotId == nil, await session.createTask(for: room, title: nil) else {
                showError("Couldn't create the thread. Try again when the current reply finishes.")
                return
            }
        }
        dismiss()
    }

    private func switchTo(_ task: BotTask) async {
        switch current {
        case let .bot(bot):
            guard session.state.bot(bot.id)?.projected(forThread: task.threadId) != nil else {
                showError("This thread is no longer available. Choose another thread.")
                return
            }
            onSelectThread(task.threadId)
        case let .room(room):
            if task.threadId != room.threadId {
                guard room.busyBotId == nil, await session.switchTask(task, for: room) else {
                    showError("Couldn't switch threads. Try again when the current reply finishes.")
                    return
                }
            }
        }
        dismiss()
    }

    private func rename(_ task: BotTask, title: String) async {
        let succeeded: Bool
        switch current {
        case let .bot(bot): succeeded = await session.renameTask(task, for: bot, title: title)
        case let .room(room): succeeded = await session.renameTask(task, for: room, title: title)
        }
        guard succeeded else {
            showError("Couldn't rename the thread. Your title is kept above so you can try again.")
            return
        }
        taskToRename = nil
        renameFocused = false
    }

    private func delete(_ task: BotTask) async {
        // Recheck after the confirmation; an SSE update may have made it busy.
        guard tasks.count > 1,
              let liveTask = tasks.first(where: { $0.threadId == task.threadId }),
              current.isBot ? liveTask.busy != true : !current.busy else {
            showError("This thread can't be deleted while it's working or if it's the last thread.")
            return
        }
        switch current {
        case let .bot(bot):
            guard await session.deleteTask(liveTask, for: bot) != nil else {
                showError("Couldn't delete the thread. Try again.")
                return
            }
            if task.threadId == bot.threadId { dismiss() }
        case let .room(room):
            guard await session.deleteTask(liveTask, for: room) else {
                showError("Couldn't delete the thread. Try again.")
                return
            }
        }
        if taskToRename?.threadId == task.threadId {
            taskToRename = nil
            renameFocused = false
        }
    }
}
