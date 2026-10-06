// The line under a chat's name in comfortable Home and search, kept between
// renders.
//
// `rosterPreview` folds a thread's whole visible transcript by the Activity
// setting. Home asked for it for every chat on every render, and a busy
// fleet renders Home about twelve times a second while only the threads that
// took a frame have changed. A line is now reused while everything it was
// folded from is unchanged.
import Foundation

public final class RosterPreviewCache {
    /// What a line was folded from: the inputs of `visibleTranscript` (the
    /// stored transcript, the branch's leaf, an edit in flight) and the
    /// setting. A reused line is the line a fresh fold would give.
    private struct Entry {
        let transcript: [Message]
        let leafId: String?
        let pendingEdit: PendingEdit?
        let detail: ActivityDetail
        let preview: String
    }

    private var entries: [String: Entry] = [:]
    /// How many lines were folded rather than reused; for the tests.
    public private(set) var folds = 0

    public init() {}

    /// `rosterPreview(state.visibleTranscript(forThread:), detail:)`, folded
    /// only when the thread changed since it was last asked for.
    ///
    /// An unchanged transcript shares its storage with the one kept here, so
    /// telling it apart costs one comparison of identity, not a walk.
    /// Sharing is not free now that the fold writes transcripts in place:
    /// the first write to a thread after a render that kept it copies that
    /// thread once. That is one copy per changed thread per render, where
    /// the fold it saves copied every message of every thread into rows on
    /// every render. A per-thread revision from the state would make this a
    /// counter comparison and drop the copy; Home lets go of the cache in
    /// compact density, where no row shows a preview.
    public func preview(forThread threadId: String, in state: CompanionState, detail: ActivityDetail) -> String {
        let transcript = state.transcript(forThread: threadId)
        let leafId = state.activeLeafIds[threadId] ?? state.bot(forThread: threadId)?.activeLeafId
        let pendingEdit = state.pendingEdits[threadId]
        if let entry = entries[threadId], entry.detail == detail, entry.leafId == leafId,
           entry.pendingEdit == pendingEdit, entry.transcript == transcript {
            return entry.preview
        }
        let preview = rosterPreview(state.visibleTranscript(forThread: threadId), detail: detail)
        folds += 1
        entries[threadId] = Entry(
            transcript: transcript, leafId: leafId, pendingEdit: pendingEdit, detail: detail, preview: preview
        )
        return preview
    }

    /// Forgets every thread but these, so a chat the roster no longer lists
    /// does not keep its transcript alive here.
    public func keepOnly(_ threadIds: Set<String>) {
        guard entries.keys.contains(where: { !threadIds.contains($0) }) else { return }
        entries = entries.filter { threadIds.contains($0.key) }
    }

    /// Forgets everything: nothing on screen shows a preview.
    public func removeAll() {
        guard !entries.isEmpty else { return }
        entries.removeAll()
    }
}
