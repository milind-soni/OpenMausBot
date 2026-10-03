// Where the chat's preferences are stored.
//
// `@AppStorage` rather than an observable object on purpose: the settings
// screen writes these and the chat reads them, and AppStorage already keeps
// both in step through UserDefaults. One place for the key strings is the
// only thing a shared type is needed for.
import Foundation
import SwiftUI
import CompanionCore

enum PrefKey {
    static let islandIntro = "companion.prefs.islandIntro"
    static let islandSeen = "companion.prefs.islandSeen"
    static let activityDetail = "companion.prefs.activityDetail"
    static let quickReplies = "companion.prefs.quickReplies"
    static let language = "companion.prefs.language"
    /// Per device, like the desktop's sidebar density: a phone and a laptop
    /// have different room for a list.
    static let rosterDensity = "companion.prefs.rosterDensity"
    /// Live calls: speaker (true, the default) or earpiece. A phone-side choice.
    static let liveSpeaker = "companion.prefs.liveSpeaker"
}

extension ActivityDetail {
    /// The reader's Activity setting, for code that is not a view and so
    /// cannot hold an `@AppStorage` of its own: Live Activities, the widget
    /// writer and Walkie read the same line the Updates pill does.
    static var stored: ActivityDetail {
        ActivityDetail(rawValue: UserDefaults.standard.string(forKey: PrefKey.activityDetail) ?? "") ?? .full
    }
}

/// The set of chats whose island intro has already played.
///
/// Stored as JSON in the same defaults as everything else rather than in its
/// own store: it is a handful of ids, and a chat that loses its entry simply
/// plays its intro once more.
enum IslandSeen {
    static func contains(_ id: String, in json: String) -> Bool {
        decode(json).contains(id)
    }

    static func adding(_ id: String, to json: String) -> String {
        var seen = decode(json)
        guard seen.insert(id).inserted else { return json }
        guard let data = try? JSONEncoder().encode(seen.sorted()) else { return json }
        return String(decoding: data, as: UTF8.self)
    }

    private static func decode(_ json: String) -> Set<String> {
        guard let data = json.data(using: .utf8),
              let list = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(list)
    }
}
