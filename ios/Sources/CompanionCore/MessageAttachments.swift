import Foundation

/// One attachment waiting in the mobile composer. The bytes are app-owned:
/// picker URLs are copied before this value is created, so a later send never
/// depends on a security-scoped URL still being alive.
public struct PendingMessageAttachment: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case image
        case file
    }

    public let id: UUID
    public let data: Data
    public let name: String
    public let mime: String
    public let kind: Kind

    public init(
        id: UUID = UUID(),
        data: Data,
        name: String,
        mime: String,
        kind: Kind
    ) {
        self.id = id
        self.data = data
        self.name = name
        self.mime = mime
        self.kind = kind
    }

    public var bytes: Int { data.count }
}

public enum AttachmentPolicyError: Error, LocalizedError, Equatable, Sendable {
    case tooManyItems
    case totalTooLarge
    case invalidName
    case unsupportedType(String)
    case itemTooLarge(name: String, limitMB: Int)

    public var errorDescription: String? {
        switch self {
        case .tooManyItems:
            return "Attach up to 4 items at a time."
        case .totalTooLarge:
            return "Those attachments are larger than 50 MB together."
        case .invalidName:
            return "That file doesn't have a valid filename."
        case let .unsupportedType(name):
            return "\(name) isn't a supported file. Try PDF, text, Word, Excel, or PowerPoint."
        case let .itemTooLarge(name, limitMB):
            return "\(name) is larger than \(limitMB) MB."
        }
    }
}

/// The same limits apply to the in-app composer and the Share extension.
/// Keeping the policy in CompanionCore prevents either entry point from
/// accepting an attachment that the authenticated upload route will reject.
public enum AttachmentPolicy {
    public static let maximumItems = 4
    public static let maximumTotalBytes = 50 * 1_024 * 1_024
    public static let maximumImageBytes = 10 * 1_024 * 1_024
    public static let maximumFileBytes = 25 * 1_024 * 1_024

    public static let imageMIMETypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
    ]

    public static let documentMIMETypes: Set<String> = [
        "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
        "application/json", "application/pdf", "application/rtf", "text/rtf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.presentation",
    ]

    public static func normalizedMIME(_ value: String) -> String {
        value.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: true)
            .first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
    }

    public static func kind(forMIME value: String) -> PendingMessageAttachment.Kind? {
        let mime = normalizedMIME(value)
        if imageMIMETypes.contains(mime) { return .image }
        if documentMIMETypes.contains(mime) { return .file }
        return nil
    }

    public static func validate(_ attachments: [PendingMessageAttachment]) throws {
        guard attachments.count <= maximumItems else { throw AttachmentPolicyError.tooManyItems }
        guard attachments.reduce(0, { $0 + $1.data.count }) <= maximumTotalBytes else {
            throw AttachmentPolicyError.totalTooLarge
        }

        for attachment in attachments {
            let name = attachment.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard validDisplayName(name) else { throw AttachmentPolicyError.invalidName }
            let mime = normalizedMIME(attachment.mime)
            switch attachment.kind {
            case .image:
                guard imageMIMETypes.contains(mime) else {
                    throw AttachmentPolicyError.unsupportedType(name)
                }
                guard attachment.data.count <= maximumImageBytes else {
                    throw AttachmentPolicyError.itemTooLarge(name: name, limitMB: 10)
                }
            case .file:
                guard documentMIMETypes.contains(mime) else {
                    throw AttachmentPolicyError.unsupportedType(name)
                }
                guard attachment.data.count <= maximumFileBytes else {
                    throw AttachmentPolicyError.itemTooLarge(name: name, limitMB: 25)
                }
            }
        }
    }

    static func validMIME(_ value: String) -> Bool {
        let mime = normalizedMIME(value)
        guard !mime.isEmpty, mime.utf8.count <= 127, mime.contains("/") else { return false }
        return mime.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                || [33, 35, 36, 38, 43, 45, 46, 47, 94, 95].contains(byte)
        }
    }

    private static func validDisplayName(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 255
            && !value.contains("/") && !value.contains("\\")
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
}

/// What tapping a Markdown link in a message is allowed to do. Web links go
/// to the system. Absolute desktop paths go back through the authenticated
/// companion file route. Relative paths are resolved by that route against
/// the originating conversation's workspace. Custom schemes do nothing.
public enum LocalMessageLink: Equatable, Sendable {
    case web(URL)
    case desktopFile(path: String)

    public static func resolve(_ rawValue: String) -> LocalMessageLink? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 8_192,
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { return nil }

        if isWindowsAbsolutePath(value) || isBackslashUNCPath(value) {
            return .desktopFile(path: value)
        }
        // In Markdown, //host/path is a protocol-relative web link. Keep it
        // out of the UNC path branch; file://host/path remains the explicit
        // spelling for a network share.
        if value.hasPrefix("//") {
            guard let components = URLComponents(string: "https:\(value)"),
                  let url = components.url,
                  components.host?.isEmpty == false
            else { return nil }
            return .web(url)
        }
        if value.hasPrefix("/") { return .desktopFile(path: value) }

        if let schemeRange = value.range(
            of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#,
            options: .regularExpression
        ) {
            guard schemeRange.lowerBound == value.startIndex,
                  let components = URLComponents(string: value),
                  let scheme = components.scheme?.lowercased()
            else { return nil }
            if scheme == "http" || scheme == "https" {
                guard let url = components.url, components.host?.isEmpty == false else { return nil }
                return .web(url)
            }
            if scheme == "file" {
                guard components.query == nil, components.fragment == nil else { return nil }
                guard var path = components.percentEncodedPath.removingPercentEncoding else { return nil }
                if path.hasPrefix("/"), isWindowsAbsolutePath(String(path.dropFirst())) {
                    path.removeFirst()
                }
                if let host = components.host, !host.isEmpty, host.lowercased() != "localhost" {
                    let sharePath = path.replacingOccurrences(of: "/", with: "\\")
                    path = "\\\\\(host)\(sharePath)"
                }
                guard path.hasPrefix("/") || isWindowsAbsolutePath(path) || isBackslashUNCPath(path) else {
                    return nil
                }
                return .desktopFile(path: path)
            }
            return nil
        }

        // Query strings and fragments belong to the Markdown target, not the
        // local filename. Decode the path the same way as the scoped server
        // matcher, while refusing query-only/fragment-only links.
        let delimiter = value.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? value.endIndex
        let pathPart = String(value[..<delimiter])
        guard !pathPart.isEmpty, let path = pathPart.removingPercentEncoding, !path.isEmpty else { return nil }
        return .desktopFile(path: path)
    }

    public static func resolve(_ url: URL) -> LocalMessageLink? {
        let value = url.absoluteString
        if let decoded = value.removingPercentEncoding,
           isWindowsAbsolutePath(decoded) || isBackslashUNCPath(decoded) {
            return .desktopFile(path: decoded)
        }
        return resolve(value)
    }

    private static func isWindowsAbsolutePath(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count >= 3 else { return false }
        let letter = (65...90).contains(bytes[0]) || (97...122).contains(bytes[0])
        return letter && bytes[1] == 58 && (bytes[2] == 47 || bytes[2] == 92)
    }

    private static func isBackslashUNCPath(_ value: String) -> Bool {
        value.hasPrefix("\\\\")
    }
}

/// Bytes returned by the authenticated file route. `localURL` is nil on the
/// low-level client and populated by Session after it safely writes a preview
/// into the app's temporary directory.
public struct DownloadedFile: Sendable {
    public let data: Data
    public let filename: String
    public let contentType: String
    public let localURL: URL?

    public init(data: Data, filename: String, contentType: String, localURL: URL? = nil) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
        self.localURL = localURL
    }

    public func stored(at url: URL) -> DownloadedFile {
        DownloadedFile(data: data, filename: filename, contentType: contentType, localURL: url)
    }
}
