// The home-screen widget's answer button: one tap, one response, no app.
//
// A Live Activity button runs in the app's process; a widget button runs
// in the extension, which must therefore do the whole dance itself —
// validate the ask against the snapshot it rendered, resolve the pairing
// and its token, POST the response, and publish the aftermath. The
// validation is the whole safety story: a widget is a frozen picture, and
// the world may have moved since it was drawn, so the response is only
// sent when the snapshot itself vouches that this exact pill is still
// live.
import AppIntents
import CompanionCore
import Foundation
import WidgetKit

struct WidgetAnswerIntent: AppIntent {
    static var title: LocalizedStringResource = "Answer"
    static var isDiscoverable = false

    @Parameter(title: "Thread") var threadId: String
    @Parameter(title: "Request") var requestId: String
    @Parameter(title: "Choice") var choice: String
    @Parameter(title: "Permission") var isPermission: Bool

    init() {}

    init(threadId: String, requestId: String, choice: String, isPermission: Bool) {
        self.threadId = threadId
        self.requestId = requestId
        self.choice = choice
        self.isPermission = isPermission
    }

    func perform() async throws -> some IntentResult {
        // The snapshot this widget rendered — or whatever replaced it. A
        // missing file is the changed-request case too: unpairing clears
        // the snapshot on purpose.
        let store = WidgetSnapshotStore.makeAppGroupStore()
        guard
            let snapshot = store?.read(),
            let card = snapshot.answerableCard(
                threadId: threadId,
                requestId: requestId,
                choice: choice,
                isPermission: isPermission
            )
        else { return .result(dialog: "This request has changed. Open the chat to review it.") }

        guard let connection = OpenMausSharedConnectionStore.loadRegistry()
            .connection(id: snapshot.connectionID)
        else { return .result(dialog: "This request has changed. Open the chat to review it.") }

        let token: String
        do {
            guard let paired = try OpenMausSharedKeychain.token(for: connection.id) else {
                return .result(dialog: "This request has changed. Open the chat to review it.")
            }
            token = paired
        } catch let error as OpenMausSharedKeychainError where error.isLocked {
            // errSecInteractionNotAllowed: the phone is locked and the
            // pairing is protected. Name the one thing that unblocks the
            // person instead of wearing a network error's clothes.
            return .result(dialog: "Unlock iPhone, then answer again.")
        } catch {
            return .result(dialog: "Open MausBot to answer.")
        }

        do {
            // reviewedSha256 stays nil on purpose: that field is the
            // skill-request review receipt, and a widget may never answer
            // one — answerableCard already refused every skill card.
            // An answer is consumed on first delivery, so it replays onto
            // another route only when the failure proves the request never
            // left the phone; anything ambiguous could have landed.
            let outcome = try await WidgetRouteRequest.perform(
                connection: connection,
                token: token,
                replay: .onlyWhenUndelivered
            ) { client in
                try await client.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: card.responseBehavior(for: choice)
                )
            }

            // `unavailable` is the server saying the action never ran — the
            // turn ended or the ask timed out — so the pill must not claim
            // the answer landed. The row still leaves either way: the
            // snapshot vouched for a live ask whose card is now closed, and
            // a second tap must not re-ask it.
            let dialog: IntentDialog = outcome == "unavailable"
                ? "This request is no longer available. Open the chat to review it."
                : "Answered"

            // The answered row leaves the home screen immediately — even
            // when the refresh behind it cannot reach the computer — so a
            // second tap cannot double-answer from a stale picture.
            if let store {
                try? store.write(snapshot.removingRow(answeredInThread: threadId))
            }
            WidgetCenter.shared.reloadAllTimelines()
            await WidgetSnapshotRefresh.refresh(connection: connection, token: token, store: store)
            return .result(dialog: dialog)
        } catch {
            return .result(dialog: "Open MausBot to answer.")
        }
    }
}
