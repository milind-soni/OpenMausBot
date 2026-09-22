import Foundation

/// One folder's visible threads, or the unfiled threads after the folders.
public struct BotThreadGroup: Identifiable, Hashable, Sendable {
    public let project: BotProject?
    public let tasks: [BotTask]

    public var id: String { project.map { "project:\($0.id)" } ?? "unfiled" }
}

/// Pin, then newest update. Equal stamps keep the caller's order.
public func threadsInListOrder(_ threads: [BotTask]) -> [BotTask] {
    threads.enumerated()
        .sorted { lhs, rhs in
            let leftPinned = lhs.element.pinned == true
            let rightPinned = rhs.element.pinned == true
            if leftPinned != rightPinned { return leftPinned && !rightPinned }
            let left = lhs.element.listStamp
            let right = rhs.element.listStamp
            if left != right { return left > right }
            return lhs.offset < rhs.offset
        }
        .map(\.element)
}

extension BotTask {
    public var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled thread" : trimmed
    }
}

extension Bot {
    /// Saved folder order is preserved. Missing folders leave their threads
    /// in the unfiled group. Within every group, pinned threads come first
    /// and the rest follow the newest update. Attention stays on the row;
    /// it does not change this order. `attentionOrderedTasks` keeps the
    /// old attention order for Updates and Live Activity.
    /// A folder-name search keeps all of that folder's visible threads,
    /// in relevance order rather than attention tiers.
    ///
    /// Threads a bot closed are folded away by default, the way the desktop
    /// sidebar folds them: a PM bot that opened ten helper threads and closed
    /// them must not leave ten rows behind. They are never gone — a search
    /// or `includingClosed` (the manage sheet) lists them, and a closed
    /// thread that is running, unread, or open here stays in the list. A
    /// thread the person archived folds away the same way, with the same
    /// attention override.
    /// - Parameter queuedThreadIds: threads holding a queued send, from the
    ///   client's queue state. A closed or archived thread with a held send
    ///   stays in the list the way a running one does — activity strings
    ///   never say this, because the harness reports queues out-of-band.
    public func threadGroups(
        matching query: String = "",
        includingClosed: Bool = false,
        queuedThreadIds: Set<String> = []
    ) -> [BotThreadGroup] {
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
                task.pinned == true
                    || !(task.isClosed || task.isArchived)
                    || task.demandsAttention(queued: queuedThreadIds.contains(task.threadId))
                    || task.threadId == threadId
            }
        }
        let ordered = threadsInListOrder(threads)

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
    /// person most, then working/busy, then queued, then unread. A held send
    /// is client state, so it ranks in the queued tier the way the wire
    /// value does. The thread being looked at rides just above the idle
    /// tail; idle threads keep stored order. Mirrors the desktop's
    /// attentionRank so the tree and the manage sheet agree on what sits on
    /// top; searches keep relevance order, as on desktop and Android.
    private func attentionRank(_ task: BotTask, queued: Bool) -> Int {
        if task.activity == "waiting-on-you" { return 0 }
        if task.busy == true || task.activity == "working" { return 1 }
        if task.activity == "queued" || queued { return 2 }
        if task.unread == true { return 3 }
        if task.threadId == threadId { return 4 }
        return 5
    }

    /// The bell, Updates, and Live Activity stay on attention order. The
    /// thread tree uses `threadsInListOrder` instead.
    public func attentionOrderedTasks(queuedThreadIds: Set<String> = []) -> [BotTask] {
        let threads: [BotTask]
        if tasks == nil {
            threads = [BotTask(
                threadId: threadId, title: "", createdAt: createdAt,
                modelSelection: modelSelection, busy: busy, waitingOnTeammate: waitingOnTeammate,
                unread: unread,
                approvalMode: approvalMode, autoApprove: autoApprove, alwaysAllow: alwaysAllow
            )]
        } else {
            threads = visibleTasks.filter { task in
                !(task.isClosed || task.isArchived)
                    || task.demandsAttention(queued: queuedThreadIds.contains(task.threadId))
                    || task.threadId == threadId
            }
        }
        return threadsInAttentionOrder(threads, queuedThreadIds: queuedThreadIds)
    }

    /// Order, never filter: whatever the caller passed stays in the list,
    /// only its position changes. The stored index rides along so equal
    /// ranks keep stored order even where sort is not guaranteed stable.
    private func threadsInAttentionOrder(
        _ threads: [BotTask],
        queuedThreadIds: Set<String>
    ) -> [BotTask] {
        threads.enumerated()
            .map { (index: $0.offset, task: $0.element) }
            .sorted {
                let lhs = attentionRank($0.task, queued: queuedThreadIds.contains($0.task.threadId))
                let rhs = attentionRank($1.task, queued: queuedThreadIds.contains($1.task.threadId))
                return lhs == rhs ? $0.index < $1.index : lhs < rhs
            }
            .map(\.task)
    }
}
