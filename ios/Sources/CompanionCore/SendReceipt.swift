// What the harness says it did with a message the moment it was posted.
//
// A send is not one outcome. When the bot is idle the line lands in the
// transcript and a turn starts. When the bot is mid-turn there are two more:
// an engine with a live session can take the words INTO the running turn
// (`steered`), and one that cannot has the harness hold them off-transcript
// until the turn settles (`queued`) — deliberately off-transcript, because a
// held line appended now would become the active leaf and the rest of the
// running turn would hang off something the model never saw.
//
// The distinction only exists in the POST's 202 body. A client that throws
// that body away, as this one used to, shows nothing at all for a queued
// send: the composer clears and the words reappear minutes later, or not at
// all. So the receipt is the contract, and it is decoded, not ignored.
import Foundation

public enum SendReceipt: Hashable, Sendable {
    /// In the transcript now. `steered` means it went into a turn that was
    /// already running rather than starting one.
    case sent(threadId: String?, steered: Bool)
    /// Held in the harness's steer queue until the current turn settles.
    case queued(queueId: String, threadId: String)

    public var queued: (queueId: String, threadId: String)? {
        guard case let .queued(queueId, threadId) = self else { return nil }
        return (queueId, threadId)
    }
}

/// The 202 body, read leniently. Every field is optional on purpose: a
/// harness older than this app answers `{ok:true}` and nothing else, and
/// that is a plain send, not a failure.
struct SendReceiptBody: Decodable {
    var threadId: String?
    var queued: Bool?
    var queueId: String?
    var steered: Bool?

    var receipt: SendReceipt {
        if queued == true, let queueId, let threadId {
            return .queued(queueId: queueId, threadId: threadId)
        }
        return .sent(threadId: threadId, steered: steered == true)
    }
}
