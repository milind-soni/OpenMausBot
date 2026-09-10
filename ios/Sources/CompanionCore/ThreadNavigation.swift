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
    /// folders leave their threads accessible in the unfiled group.
    /// A folder-name search keeps all of that folder's visible threads.
    public func threadGroups(matching query: String = "") -> [BotThreadGroup] {
        let threads: [BotTask]
        if tasks == nil {
            // Older computers have one conversation but no task metadata.
            // An explicitly empty modern list must stay empty.
            threads = [BotTask(
                threadId: threadId, title: "", createdAt: createdAt,
                modelSelection: modelSelection, busy: busy, unread: unread,
                approvalMode: approvalMode, autoApprove: autoApprove, alwaysAllow: alwaysAllow
            )]
        } else {
            threads = visibleTasks
        }

        var projectIDs = Set<String>()
        var groups = (projects ?? []).compactMap { project -> BotThreadGroup? in
            guard projectIDs.insert(project.id).inserted else { return nil }
            let filed = threads.filter { $0.projectId == project.id }
            return filed.isEmpty ? nil : BotThreadGroup(project: project, tasks: filed)
        }
        let unfiled = threads.filter { task in
            task.projectId.map { !projectIDs.contains($0) } ?? true
        }
        if !unfiled.isEmpty {
            groups.append(BotThreadGroup(project: nil, tasks: unfiled))
        }

        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !search.isEmpty else { return groups }
        return groups.compactMap { group in
            if group.project?.name.localizedStandardContains(search) == true { return group }
            let matches = group.tasks.filter { $0.displayTitle.localizedStandardContains(search) }
            return matches.isEmpty ? nil : BotThreadGroup(project: group.project, tasks: matches)
        }
    }
}
