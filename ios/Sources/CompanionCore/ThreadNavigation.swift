import Foundation

/// One folder's visible threads, or the unfiled threads after the folders.
public struct BotThreadGroup: Identifiable, Hashable, Sendable {
    public let project: BotProject?
    public let tasks: [BotTask]

    public var id: String { project.map { "project:\($0.id)" } ?? "unfiled" }
}

extension BotTask {
    public var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled thread" : trimmed
    }
}

extension Bot {
    /// Saved folder order and server thread order are preserved. Missing
    /// folders leave their threads accessible in the unfiled group, and
    /// within every group attention outranks recency: a thread that needs
    /// the person floats above the idle tail, which keeps stored order.
    /// A folder-name search keeps all of that folder's visible threads,
    /// in relevance order rather than attention tiers.
    ///
    /// Threads a bot closed are folded away by default, the way the desktop
    /// sidebar folds them: a PM bot that opened ten helper threads and closed
    /// them must not leave ten rows behind. They are never gone — a search
    /// or `includingClosed` (the manage sheet) lists them, and a closed
    /// thread that is working, unread, or open here stays in the list. A
    /// thread the person archived folds away the same way, with the same
    /// attention override: a working or waiting archived thread resurfaces.
    public func threadGroups(matching query: String = "", includingClosed: Bool = false) -> [BotThreadGroup] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let threads: [BotTask]
        if tasks == nil {
            // Older computers have one conversation but no task metadata.
            // An explicitly empty modern list must stay empty.
            threads = [BotTask(
                threadId: threadId, title: "", createdAt: createdAt,
                modelSelection: modelSelection, busy: busy, waitingOnTeammate: waitingOnTeammate,
                unread: unread,
                approvalMode: approvalMode, autoApprove: autoApprove, alwaysAllow: alwaysAllow
            )]
        } else if includingClosed || !search.isEmpty {
            threads = visibleTasks
        } else {
            threads = visibleTasks.filter { task in
                !(task.isClosed || task.isArchived) || task.demandsAttention || task.threadId == threadId
            }
        }
        let ordered = search.isEmpty ? threadsInAttentionOrder(threads) : threads

        var projectIDs = Set<String>()
        var groups = (projects ?? []).compactMap { project -> BotThreadGroup? in
            guard projectIDs.insert(project.id).inserted else { return nil }
            let filed = ordered.filter { $0.projectId == project.id }
            return filed.isEmpty ? nil : BotThreadGroup(project: project, tasks: filed)
        }
        let unfiled = ordered.filter { task in
            task.projectId.map { !projectIDs.contains($0) } ?? true
        }
        if !unfiled.isEmpty {
            groups.append(BotThreadGroup(project: nil, tasks: unfiled))
        }

        guard !search.isEmpty else { return groups }
        return groups.compactMap { group in
            if group.project?.name.localizedStandardContains(search) == true { return group }
            let matches = group.tasks.filter { $0.displayTitle.localizedStandardContains(search) }
            return matches.isEmpty ? nil : BotThreadGroup(project: group.project, tasks: matches)
        }
    }

    /// Attention outranks recency within a bot: waiting-on-you needs the
    /// person most, then working/busy, then queued, then unread. The thread
    /// being looked at rides just above the idle tail; idle threads keep
    /// stored order. Mirrors the desktop's attentionRank so the tree and
    /// the manage sheet agree on what sits on top; searches keep relevance
    /// order, as on desktop and Android.
    private func attentionRank(_ task: BotTask) -> Int {
        if task.activity == "waiting-on-you" { return 0 }
        if task.busy == true || task.activity == "working" { return 1 }
        if task.activity == "queued" { return 2 }
        if task.unread == true { return 3 }
        if task.threadId == threadId { return 4 }
        return 5
    }

    /// Order, never filter: whatever the caller passed stays in the list,
    /// only its position changes. The stored index rides along so equal
    /// ranks keep stored order even where sort is not guaranteed stable.
    private func threadsInAttentionOrder(_ threads: [BotTask]) -> [BotTask] {
        threads.enumerated()
            .map { (index: $0.offset, task: $0.element) }
            .sorted {
                let lhs = attentionRank($0.task)
                let rhs = attentionRank($1.task)
                return lhs == rhs ? $0.index < $1.index : lhs < rhs
            }
            .map(\.task)
    }
}
