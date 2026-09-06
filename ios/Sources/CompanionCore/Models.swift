// The harness's wire types, in Swift.
//
// These mirror `server/store.ts` and the payloads in `server/index.ts`.
// There is no shared type system across the two languages, so the contract
// is pinned by fixtures instead: `Tests/CompanionCoreTests/Fixtures` holds
// real responses captured from a running server, and the decoding tests
// read them. When the server changes a payload, a test here fails.
//
// Everything the server may omit is optional, and nothing is decoded more
// strictly than it has to be — a phone that refuses to show a conversation
// because one message gained a field is worse than one that ignores it.
import Foundation

// MARK: - Messages

public struct SkillRequestCardData: Codable, Hashable, Sendable {
    public var version: Int
    public var requestId: String
    public var botId: String
    public var threadId: String
    public var stagedId: String
    public var action: String
    public var name: String
    public var gist: String
    /// Optional so approval cards persisted by older desktop builds still decode.
    public var source: String?
    /// The exact, secret-scrubbed instructions the approval enables.
    public var preview: String?
    public var sha256: String?
    public var warnings: [String]
    public var createdAt: Int64

    /// A current client echoes this only after it can show the complete
    /// proposal. Legacy cards remain visible but deny-only.
    public var reviewedSha256: String? {
        guard let preview, !preview.isEmpty, let sha256, sha256.utf8.count == 64 else { return nil }
        let hexadecimal = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
        guard sha256.unicodeScalars.allSatisfy(hexadecimal.contains) else { return nil }
        return sha256
    }
}

public struct OptionCard: Codable, Hashable, Sendable {
    public var title: String
    public var subtitle: String
    public var options: [String]
    public var answered: String?
    public var dismissed: Bool?
    /// Present when this card is a live provider ask — the thing that makes
    /// it answerable rather than historical.
    public var requestId: String?
    public var tool: String?
    /// Why auto mode stopped to ask anyway.
    public var held: String?
    /// The narrow grant "always allow" would remember, e.g. `Bash:git`.
    public var allowKey: String?
    /// Learned skills must show their complete reviewed contents before an
    /// approval button is offered on a compact companion surface.
    public var skillRequest: SkillRequestCardData? = nil

    /// A card is actionable while it is unanswered and still has a request
    /// behind it. Everything else is transcript.
    public var isPending: Bool {
        requestId != nil && answered == nil && dismissed != true
    }

    /// Permission cards carry a tool; questions do not.
    public var isPermission: Bool { tool != nil }

    /// The wire API accepts an approval behavior rather than the button's
    /// display text. Treat the one refusal as deny and every other offered
    /// permission choice as allow: providers may say "Approve", "Yes", or
    /// "Always allow", and none of those should accidentally become a deny.
    public func responseBehavior(for choice: String) -> String {
        Self.responseBehavior(for: choice, isPermission: isPermission)
    }

    /// The ID-only form is used by Live Activity buttons, which carry the
    /// card kind but not the full card payload.
    public static func responseBehavior(for choice: String, isPermission: Bool) -> String {
        guard isPermission else { return "answer" }
        return isRefusal(choice) ? "deny" : "allow"
    }

    /// Shared by all of the app's card surfaces and by Live Activities.
    public static func isRefusal(_ choice: String) -> Bool {
        let normalized = choice.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["deny", "cancel", "dismiss"].contains(normalized)
    }

    /// A provider may include the standing grant as an option of its own.
    /// Only remember it when the server supplied the narrow grant key.
    public func shouldRememberPermission(for choice: String) -> Bool {
        guard isPermission, allowKey != nil else { return false }
        let normalized = choice.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.caseInsensitiveCompare("Always allow") == .orderedSame
    }
}

public struct ToolActivity: Codable, Hashable, Sendable {
    public var name: String
    public var ok: Bool?
    /// The same chip as a phrase a voice can read.
    public var spoken: String?
    /// Marks an error fixed by installing something, not by retrying.
    public var setup: Bool?
}

/// A credential request created by the desktop for one paused task.
///
/// The phone may fill this request only through the QR-pinned HPKE transport.
/// The payload contains identifiers and display copy, never the credential.
public struct SecretRequestCardData: Codable, Hashable, Sendable {
    public var target: String?
    public var label: String?
    public var description: String?
    public var placeholder: String?
    public var helpUrl: String?
    public var requestKey: String?
    public var provided: Bool?
    public var dismissed: Bool?
    public var resumed: Bool?
    public var error: String?

    public var isPending: Bool { provided != true && dismissed != true }
}

public struct Sender: Codable, Hashable, Sendable {
    public var botId: String
    public var name: String
    public var color: String
}

public struct Reaction: Codable, Hashable, Sendable {
    public var emoji: String
    public var by: String
}

public struct CommChip: Codable, Hashable, Sendable {
    public var groupId: String
    public var withBotId: String
    public var withName: String
    public var withColor: String
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case text, options, activity, screen, secret
        /// A kind this build has never heard of.
        ///
        /// Not decorative. `kind` is not optional, so without this a single
        /// unrecognised message fails the decode of the whole response it
        /// arrived in — the thread does not render one message oddly, it
        /// does not render. The harness gains message kinds on its own
        /// schedule and the phone is updated on the App Store's, so "newer
        /// computer than phone" is the normal state of things, not an edge
        /// case. Degrading to the text a message carries is worth more than
        /// being right about its shape.
        case unknown

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum Role: String, Codable, Sendable {
        case bot, user

        /// Same reasoning, and `bot` rather than a third case: an unplaceable
        /// message drawn as yours would be the phone claiming you said
        /// something you did not.
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .bot
        }
    }

    public var id: String
    public var role: Role
    public var kind: Kind
    public var at: Double
    public var text: String?
    public var card: OptionCard?
    public var secret: SecretRequestCardData?
    public var tool: ToolActivity?
    /// The message this one follows; nil at the thread root. Two messages
    /// sharing a parent are a fork.
    public var parentId: String?
    /// Rooms: which member said this.
    public var from: Sender?
    public var reactions: [Reaction]?
    public var comm: CommChip?
    /// Screen messages in the paged shape: the pixels live behind
    /// `/api/threads/:threadId/messages/:id/image` rather than inline.
    public var hasImage: Bool?
    /// Screen messages in the full shape: base64 pixels, inline.
    public var png: String?
    public var mime: String?

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

// MARK: - Bots and rooms

public struct ModelSelection: Codable, Hashable, Sendable {
    public var instanceId: String
    public var model: String
    /// Optional reasoning effort passed through to engines that support it.
    /// Older computers omit this field, which means the engine default.
    public var effort: String?

    public init(instanceId: String, model: String, effort: String? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.effort = effort
    }
}

public struct BotTask: Codable, Hashable, Sendable {
    public var threadId: String
    public var title: String
    public var createdAt: Double
}

public struct Bot: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var title: String
    public var description: String
    public var notifications: Bool
    public var color: String
    /// An app-owned `/api/attachments/:name` URL. The URL is intentionally
    /// relative so every paired device fetches it from its own computer.
    public var avatarUrl: String?
    /// `mascot` draws the mascot itself — its gradient body with the bot's
    /// live face on top. The rest crop `avatarUrl` and replace the mascot
    /// entirely, and the value names the mask. See `shared/bot-avatar.ts`.
    public var avatarCrop: AvatarCrop?
    public var unread: Bool
    public var modelSelection: ModelSelection
    public var createdAt: Double
    public var busy: Bool?
    public var pinned: Bool?
    public var hidden: Bool?
    /// Desktop sidebar section. Missing or blank means the built-in Bots area.
    public var section: String?
    public var chiefOfStaff: Bool?
    /// ask, auto, full, or custom. Missing on older harnesses; autoApprove
    /// remains the compatibility mirror for older companion builds.
    public var approvalMode: String?
    public var autoApprove: Bool?
    public var alwaysAllow: [String]?
    public var computer: String?
    /// Which cloud computer backs `computer == "cloud"`. Absent (older
    /// harnesses included) means the hosted Box; "vps" means the user's own
    /// server, which has no interactive desktop to offer a phone.
    public var cloudBackend: String?
    public var speakReplies: Bool?
    public var voice: String?
    public var mascotExpression: String?
    /// Which body from the mascot body catalog this bot wears. Absent (an
    /// older harness included) means the shipped `cursor` silhouette.
    public var mascotBody: String?
    public var tasks: [BotTask]?
    public var messages: [Message]?
    public var activeLeafId: String?
    /// Paged responses only: there is more transcript above what you got.
    public var hasMore: Bool?
}

public enum AvatarCrop: String, Codable, CaseIterable, Hashable, Sendable {
    case mascot, circle, rounded, square

    /// The desktop may gain crop modes before this app updates. Falling back
    /// keeps the complete bot/fleet payload decodable and guarantees a safe,
    /// deterministic identity image instead of dropping the agent.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .mascot
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The "who" section of a bot overview: identity and its soul in one line.
public struct BotOverviewWho: Codable, Hashable, Sendable {
    public var name: String
    public var title: String
    public var blurb: String
    public var soulLead: String
}

public struct BotOverviewRecent: Codable, Hashable, Sendable {
    /// epoch milliseconds, like every other timestamp on the wire
    public var at: Double
    public var summary: String
}

/// A read-only summary of one bot: who it is, what it does, what it can
/// reach, what it won't do, and its recent activity. No settings and no
/// transcript — this is the shape a phone is allowed to poll for.
public struct BotOverview: Codable, Hashable, Sendable {
    public var who: BotOverviewWho
    public var does: [String]
    public var reaches: [String]
    public var wont: [String]
    public var recent: [BotOverviewRecent]
}

public struct GroupResponder: Codable, Hashable, Sendable {
    public var kind: String
    public var botId: String?
}

public struct Room: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var memberIds: [String]
    public var defaultResponder: GroupResponder
    public var bulletin: String
    public var unread: Bool
    public var createdAt: Double
    public var dm: Bool?
    /// Desktop sidebar section. Missing or blank means the built-in Channels area.
    public var section: String?
    public var busyBotId: String?
    /// Independent user conversations in this channel. Bot-to-bot rooms
    /// omit tasks because their transcript is the canonical private chat.
    public var tasks: [BotTask]?
    public var messages: [Message]?
    public var hasMore: Bool?
}

// MARK: - Responses

private struct Lossy<Element: Decodable>: Decodable {
    let value: Element?

    init(from decoder: Decoder) throws {
        value = try? Element(from: decoder)
    }
}

public struct Fleet: Decodable, Sendable {
    public var bots: [Bot]
    public var groups: [Room]

    private enum CodingKeys: String, CodingKey { case bots, groups }

    public init(bots: [Bot], groups: [Room]) {
        self.bots = bots
        self.groups = groups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bots = try container.decodeIfPresent([Lossy<Bot>].self, forKey: .bots)?.compactMap(\.value) ?? []
        groups = try container.decodeIfPresent([Lossy<Room>].self, forKey: .groups)?.compactMap(\.value) ?? []
    }
}

public struct ThreadPage: Codable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool?
}

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
    public var threadId: String
    public var messageId: String
    public var at: Double
    public var role: Message.Role
    public var kind: Message.Kind
    public var snippet: String
    public var matchStart: Int
    public var matchLength: Int
    public var botId: String?
    public var groupId: String?
    public var name: String
    public var task: String?
    public var onActivePath: Bool

    public var id: String { "\(threadId):\(messageId)" }
}

public struct TranscriptExport: Sendable {
    public var data: Data
    public var filename: String
    public var contentType: String

    public init(data: Data, filename: String, contentType: String) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
    }
}

public struct PairedDevice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double
}

public struct PairResponse: Codable, Sendable {
    public var token: String
    public var device: PairedDevice
    /// What the computer calls itself — worth showing so someone with two
    /// paired machines can tell them apart.
    public var serverName: String
    /// Every address the computer answers on, best first. Stored with the
    /// connection so the app can walk to the next one when the address it
    /// paired on stops resolving. Absent from older sidecars.
    public var hosts: [String]?
    /// Full HTTPS/HTTP routes from newer sidecars. Absent during a staggered
    /// rollout; `hosts` remains the compatibility path for older builds.
    public var endpoints: [CompanionEndpoint]?

    private enum CodingKeys: String, CodingKey {
        case token, device, serverName, hosts, endpoints
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decode(String.self, forKey: .token)
        device = try container.decode(PairedDevice.self, forKey: .device)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)
        if container.contains(.endpoints) {
            // These routes are advisory and the credential may already have
            // been redeemed. One malformed or future-kind entry must not
            // discard the valid token and legacy host fallback with it.
            endpoints = (try? container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints))?
                .compactMap(\.value) ?? []
        } else {
            endpoints = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(device, forKey: .device)
        try container.encode(serverName, forKey: .serverName)
        try container.encodeIfPresent(hosts, forKey: .hosts)
        try container.encodeIfPresent(endpoints, forKey: .endpoints)
    }
}

/// The authenticated, refreshable connection identity advertised by the
/// companion sidecar at `GET /api/companion/endpoints`.
///
/// This intentionally mirrors only the non-secret routing subset of a pair
/// response. Existing paired phones can learn that hosted access was enabled
/// later without minting another device token or scanning another QR code.
public struct CompanionConnectionMetadata: Decodable, Sendable {
    public var serverName: String
    public var hosts: [String]?
    public var endpoints: [CompanionEndpoint]

    private enum CodingKeys: String, CodingKey { case serverName, hosts, endpoints }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)

        // Endpoint metadata is a replacement snapshot, not an optional hint.
        // Keep a future malformed kind from discarding valid routes beside it,
        // but reject a response with no usable route so the caller retains its
        // last known-good snapshot.
        let decoded = try container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints)
            .compactMap(\.value)
        let stable = decoded.enumerated().sorted {
            $0.element.priority == $1.element.priority
                ? $0.offset < $1.offset
                : $0.element.priority < $1.element.priority
        }.map(\.element)
        var seen = Set<String>()
        endpoints = stable.filter { seen.insert($0.url).inserted }.prefix(8).map { $0 }
        guard !endpoints.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .endpoints,
                in: container,
                debugDescription: "Companion endpoint metadata must contain at least one valid route."
            )
        }
    }
}

/// A freshly minted provider viewer. It is deliberately not Codable for
/// persistence: the URL is a short-lived bearer credential and belongs only
/// in memory for the browser session that requested it.
public struct CloudDesktopSession: Decodable, Sendable {
    public let url: URL

    private enum CodingKeys: String, CodingKey { case joinUrl }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decode(String.self, forKey: .joinUrl)
        guard let parsed = URL(string: raw),
              parsed.scheme?.lowercased() == "https",
              parsed.host != nil
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .joinUrl,
                in: container,
                debugDescription: "Cloud desktop URL must be HTTPS"
            )
        }
        url = parsed
    }
}

public struct ProviderSnapshot: Codable, Hashable, Sendable {
    public var state: String
    public var reason: String?
    public var authenticated: Bool?
    public var version: String?

    public var isAvailable: Bool { state == "available" }
}

public struct ModelOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
}

public struct ModelCatalog: Codable, Hashable, Sendable {
    public var `default`: String
    public var options: [ModelOption]
}

/// The small, phone-safe part of an engine's capabilities needed by bot
/// settings. Missing capabilities or effort levels mean the engine does not
/// offer a reasoning control.
public struct InstanceCapabilities: Codable, Hashable, Sendable {
    public var effortLevels: [String]?

    public init(effortLevels: [String]? = nil) {
        self.effortLevels = effortLevels
    }
}

public struct Instance: Codable, Hashable, Identifiable, Sendable {
    public var instanceId: String
    public var driverKind: String
    public var displayName: String?
    public var snapshot: ProviderSnapshot
    public var models: ModelCatalog
    public var capabilities: InstanceCapabilities? = nil

    public var id: String { instanceId }
}

public struct InstanceList: Codable, Sendable {
    public var instances: [Instance]
}

/// Which engine actually speaks — `VoiceProvider` in `server/tts/index.ts`.
/// Derived from `ConfigFlag.provider`, never decoded straight off the wire.
public enum VoiceProvider: Hashable, Sendable {
    case elevenlabs
    case system
}

public struct ConfigFlag: Codable, Hashable, Sendable {
    public var configured: Bool
    public var apiKeyConfigured: Bool?
    public var ready: Bool?
    public var voice: String?
    /// The voice engine, absent on a computer that predates the choice. Read
    /// it through `ConfigStatus.voiceProvider`, which applies the server's own
    /// fallback; nothing should compare this string directly.
    public var provider: String?
}

public struct Profile: Codable, Hashable, Sendable {
    public var name: String
    public var email: String
}

public struct ConfigStatus: Codable, Sendable {
    public var composio: ConfigFlag?
    public var box: ConfigFlag?
    public var tts: ConfigFlag?
    public var imageGen: ConfigFlag?
    public var profile: Profile?

    /// Whether synthesis is available on the paired computer. Deliberately
    /// provider-neutral: under ElevenLabs this is a key on file, while under
    /// the built-in engine `providerConfigured` in `server/tts/index.ts`
    /// reports whether the computer has voices it can use and no credential
    /// exists at all. Only the reason behind the flag changes — so anything
    /// that *explains* a false here has to ask `voiceProvider` first.
    /// Either way the credential itself never appears in this response.
    public var isTTSConfigured: Bool {
        tts?.configured == true || tts?.apiKeyConfigured == true
    }

    /// An empty voice means there is no workspace fallback. Clients must not
    /// present that state as a usable "Workspace default" choice.
    public var hasWorkspaceDefaultVoice: Bool {
        !(tts?.voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    public func canSpeak(agentVoice: String?) -> Bool {
        let hasAgentVoice = !(agentVoice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        return isTTSConfigured && (hasAgentVoice || hasWorkspaceDefaultVoice)
    }

    /// `voiceProvider(cfg)` in `server/tts/index.ts`: only the exact string
    /// `"system"` selects the built-in engine. A missing field — a computer
    /// older than the choice — and an engine this build has never heard of
    /// both fall back to ElevenLabs, which is the server's own rule and what
    /// keeps an unrecognised engine from being explained to the user with
    /// copy written for a different one.
    public var voiceProvider: VoiceProvider {
        tts?.provider == "system" ? .system : .elevenlabs
    }
}

// MARK: - Agent profiles, voices, routines, and notifications

public struct BotProfilePatch: Encodable, Sendable {
    /// `nil` means "leave the field alone". Profile actions deliberately send
    /// only the fields they own so an avatar upload cannot overwrite identity
    /// or voice values that changed on another client while the sheet was open.
    public var name: String?
    public var title: String?
    public var description: String?
    public var notifications: Bool?
    public var avatarUrl: AvatarURL?
    public var avatarCrop: AvatarCrop?
    public var mascotBody: String?
    public var voice: String?
    public var speakReplies: Bool?

    /// `avatarUrl` needs three wire states: omitted, a stored path, or JSON
    /// null to clear. A nested optional would technically represent that, but
    /// makes call sites easy to get wrong (`nil` is ambiguous at a glance).
    public enum AvatarURL: Equatable, Sendable {
        case set(String)
        case clear
    }

    public init(
        name: String? = nil,
        title: String? = nil,
        description: String? = nil,
        notifications: Bool? = nil,
        avatarUrl: AvatarURL? = nil,
        avatarCrop: AvatarCrop? = nil,
        mascotBody: String? = nil,
        voice: String? = nil,
        speakReplies: Bool? = nil
    ) {
        self.name = name
        self.title = title
        self.description = description
        self.notifications = notifications
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
        self.mascotBody = mascotBody
        self.voice = voice
        self.speakReplies = speakReplies
    }

    private enum CodingKeys: String, CodingKey {
        case name, title, description, notifications, avatarUrl, avatarCrop, mascotBody, voice, speakReplies
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(name, forKey: .name)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(description, forKey: .description)
        try values.encodeIfPresent(notifications, forKey: .notifications)
        if let avatarUrl {
            switch avatarUrl {
            case let .set(path): try values.encode(path, forKey: .avatarUrl)
            case .clear: try values.encodeNil(forKey: .avatarUrl)
            }
        }
        try values.encodeIfPresent(avatarCrop, forKey: .avatarCrop)
        try values.encodeIfPresent(mascotBody, forKey: .mascotBody)
        try values.encodeIfPresent(voice, forKey: .voice)
        try values.encodeIfPresent(speakReplies, forKey: .speakReplies)
    }
}

public struct Voice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var description: String?
}

public struct RoutineSchedule: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case once, daily, interval
        /// A schedule introduced by a newer desktop. It remains visible but
        /// cannot be toggled or saved until the user chooses a supported kind.
        case unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }
    public var type: Kind
    public var at: Double?
    public var time: String?
    public var weekdays: [Int]?
    public var everyMinutes: Int?
    public var anchorAt: Int64?

    public static func once(at: Date) -> Self {
        .init(type: .once, at: at.timeIntervalSince1970 * 1_000, time: nil, weekdays: nil)
    }

    public static func daily(time: String, weekdays: [Int]) -> Self {
        .init(type: .daily, at: nil, time: time, weekdays: weekdays)
    }

    public static func interval(everyMinutes: Int, anchorAt: Date) -> Self {
        .init(
            type: .interval,
            at: nil,
            time: nil,
            weekdays: nil,
            everyMinutes: everyMinutes,
            anchorAt: Int64((anchorAt.timeIntervalSince1970 * 1_000).rounded())
        )
    }
}

public struct Routine: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool
    public var schedule: RoutineSchedule
    public var durationMinutes: Int
    public var timeoutMinutes: Int?
    public var nextRunAt: Double?
    public var createdAt: Double
    public var updatedAt: Double
}

public struct RoutineRun: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var routineId: String
    public var routineName: String
    public var prompt: String?
    public var durationMinutes: Int?
    public var timeoutMinutes: Int?
    public var botId: String
    public var runOn: String
    public var scheduledFor: Double
    public var status: String
    public var manual: Bool
    public var triggerSource: String?
    public var threadId: String?
    public var startedAt: Double?
    public var finishedAt: Double?
    public var output: String?
    public var error: String?
    public var createdAt: Double
    public var seenAt: Double?
}

public struct RoutineInput: Encodable, Sendable {
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool?
    public var schedule: RoutineSchedule
    public var durationMinutes: Int
    /// A value replaces the stored limit; nil leaves it unchanged on PATCH.
    public var timeoutMinutes: Int?
    /// Explicitly writes JSON null when `timeoutMinutes` is nil.
    public var clearTimeout: Bool

    public init(
        name: String, prompt: String, botId: String, runOn: String = "maus",
        enabled: Bool? = nil, schedule: RoutineSchedule, durationMinutes: Int = 30,
        timeoutMinutes: Int? = nil, clearTimeout: Bool = false
    ) {
        self.name = name
        self.prompt = prompt
        self.botId = botId
        self.runOn = runOn
        self.enabled = enabled
        self.schedule = schedule
        self.durationMinutes = durationMinutes
        self.timeoutMinutes = timeoutMinutes
        self.clearTimeout = clearTimeout
    }

    private enum CodingKeys: String, CodingKey {
        case name, prompt, botId, runOn, enabled, schedule, durationMinutes, timeoutMinutes
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .name)
        try values.encode(prompt, forKey: .prompt)
        try values.encode(botId, forKey: .botId)
        try values.encode(runOn, forKey: .runOn)
        try values.encodeIfPresent(enabled, forKey: .enabled)
        try values.encode(schedule, forKey: .schedule)
        try values.encode(durationMinutes, forKey: .durationMinutes)
        if let timeoutMinutes { try values.encode(timeoutMinutes, forKey: .timeoutMinutes) }
        else if clearTimeout { try values.encodeNil(forKey: .timeoutMinutes) }
    }
}

public enum RoutineRunLocation: String, CaseIterable, Codable, Hashable, Sendable {
    case maus
    case cloud
}

/// Desktop-equivalent run-location availability, derived only from paired-safe
/// status endpoints. Selecting Cloud VM requires both the host credential and
/// an available Box agent. An existing cloud routine remains editable without
/// silently changing where it runs if that VM is temporarily unavailable.
public struct RoutineRunAvailability: Equatable, Sendable {
    public var cloudConfigured: Bool
    public var cloudInstanceAvailable: Bool

    public init(config: ConfigStatus?, instances: [Instance]) {
        cloudConfigured = config?.box?.configured == true
        cloudInstanceAvailable = instances.contains {
            $0.driverKind == "boxAgent" && $0.snapshot.isAvailable
        }
    }

    public var cloudReady: Bool { cloudConfigured && cloudInstanceAvailable }

    public func canSelect(_ location: RoutineRunLocation, preserving current: RoutineRunLocation) -> Bool {
        location == .maus || cloudReady || current == .cloud
    }
}

public extension Routine {
    var runLocation: RoutineRunLocation {
        RoutineRunLocation(rawValue: runOn) ?? .maus
    }

    /// Mirrors the desktop `canToggleRoutine` policy. A one-time routine has
    /// no meaningful Resume action once its scheduled instant has passed.
    func canToggle(at date: Date = Date()) -> Bool {
        switch schedule.type {
        case .daily:
            true
        case .interval:
            (5...1_440).contains(schedule.everyMinutes ?? 0) && schedule.anchorAt != nil
        case .once:
            (schedule.at ?? -.infinity) > date.timeIntervalSince1970 * 1_000
        case .unknown:
            false
        }
    }
}

public struct NotificationTarget: Equatable, Sendable {
    public let botId: String
    public let threadId: String

    public init?(botId: String?, threadId: String?) {
        guard let botId, let threadId,
              !botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        self.botId = botId
        self.threadId = threadId
    }

    public init?(payload: [String: String]) {
        self.init(botId: payload["botId"], threadId: payload["threadId"])
    }

    public func requiresTaskSwitch(activeThreadId: String) -> Bool {
        threadId != activeThreadId
    }
}

// MARK: - Connected apps

public struct ConnectorCard: Codable, Hashable, Identifiable, Sendable {
    public var slug: String
    public var label: String
    public var blurb: String
    public var logo: String?
    public var domain: String?
    public var id: String { slug }
}

public struct ConnectorAccount: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var alias: String?
    public var status: String

    /// Composio lifecycle values include both `ACTIVE` and `INACTIVE`; an
    /// exact normalized comparison avoids rendering the latter as connected.
    public var isActive: Bool {
        status.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "ACTIVE"
    }
}

public struct ConnectorStatus: Codable, Hashable, Sendable {
    public var connected: Bool
    public var pending: Bool?
    public var status: String?
    public var accounts: [ConnectorAccount]?
}

public struct ConnectorCatalog: Codable, Sendable {
    public var configured: Bool
    public var mode: String?
    public var source: String?
    public var cards: [ConnectorCard]
}

public struct ConnectorStatuses: Codable, Sendable {
    public var configured: Bool
    public var services: [String: ConnectorStatus]
    /// `"ok"`, `"unavailable"`, or absent on a computer that predates the
    /// field. Read it through `isAuthoritative`; nothing should compare it
    /// directly.
    public var credentialStore: String?

    /// Whether `services` is an inventory or an admission of ignorance.
    ///
    /// `server/index.ts` answers an unreadable Composio credential store with
    /// an empty map *and* `credentialStore: "unavailable"`, because failing to
    /// read the store means we do not know what is connected — which is not
    /// the same as knowing nothing is. An empty map arriving that way must
    /// never be shown as "nothing is connected": every account may still be
    /// live on the computer.
    ///
    /// Only that exact string withdraws the claim. `"ok"` is authoritative,
    /// and so is a missing field — a computer old enough not to send it would
    /// otherwise have every answer treated as unknowable.
    public var isAuthoritative: Bool {
        credentialStore != "unavailable"
    }
}

/// The harness's error body. Every non-2xx response carries one.
public struct APIErrorBody: Codable, Sendable {
    public var error: String
}

/// One frame of a bot's computer, as it arrives on the stream.
public struct ScreenFrame: Hashable, Sendable {
    public var png: String
    public var mime: String

    public init(png: String, mime: String) {
        self.png = png
        self.mime = mime
    }

    /// Decoded pixels, or nil if the base64 was not what it claimed to be.
    /// Returning nil rather than throwing keeps the caller a view.
    public var data: Data? { Data(base64Encoded: png) }
}

/// `POST /api/bots` — the harness answers with the bot it made.
public struct CreatedBot: Codable, Sendable {
    public var bot: Bot
}

/// `POST /api/groups` — the harness answers with the room it made.
public struct CreatedRoom: Codable, Sendable {
    public var group: Room
}

struct SearchResponse: Codable, Sendable {
    var hits: [SearchHit]
}

struct MessageResponse: Codable, Sendable {
    var message: Message
}

struct ActiveBranchResponse: Codable, Sendable {
    var activeLeafId: String
}

struct BotResponse: Codable, Sendable {
    var bot: Bot
}
struct SidebarSectionResponse: Codable, Sendable {
    var section: String
    var bots: [Bot]
}
struct RoomResponse: Codable, Sendable {
    var group: Room
}
struct VoiceListResponse: Codable, Sendable {
    var voices: [Voice]
    var error: String?
}

struct AttachmentResponse: Codable, Sendable {
    var path: String
    var mime: String
    var bytes: Int
}

struct GeneratedAvatarResponse: Codable, Sendable {
    var avatarUrl: String
    var bot: Bot
}

struct RoutinesResponse: Codable, Sendable {
    var routines: [Routine]
    var runs: [RoutineRun]
}

struct RoutineResponse: Codable, Sendable { var routine: Routine }
struct RoutineRunResponse: Codable, Sendable { var run: RoutineRun }

struct ConnectorAuthorizationResponse: Codable, Sendable {
    var url: String
}

// MARK: - Server sessions (pairing with a server directly)

/// What `POST /api/auth/pair` returns on a server: the bearer, the session
/// it opened, and the server's public descriptor.
public struct ServerPairResponse: Codable, Sendable {
    public var token: String
    public var session: ServerSession
    public var environment: ServerEnvironment
}

public struct ServerSession: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var scopes: [String]
    public var expiresAt: Double?

    public var isAdmin: Bool { scopes.contains("admin") }
}

/// `GET /.well-known/openmausbot/environment`, served without a session.
public struct ServerEnvironment: Codable, Hashable, Sendable {
    public var environmentId: String
    public var label: String
    public var platform: String?
    public var version: String?
}
