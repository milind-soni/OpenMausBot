extension CompanionState {
    /// One activity per bot: the newest pending ask wins over its working threads.
    public func liveActivityUpdates(detail: ActivityDetail) -> [ChatUpdate] {
        var seen = Set<String>()
        return updates(detail: detail).filter { update in
            guard update.kind != .toReview, case let .bot(bot) = update.chat else { return false }
            return seen.insert(bot.id).inserted
        }
    }
}
