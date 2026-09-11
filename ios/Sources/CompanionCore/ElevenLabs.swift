// ElevenLabs text-to-speech, called straight from the phone.
//
// Walkie speaks answers with the phone's own ElevenLabs key rather than
// asking the computer to synthesize: the voice then works wherever the phone
// has internet, whatever the computer has set up. The request mirrors the
// harness's `server/tts/elevenlabs.ts` — the Flash model, 64 kbps mono MP3
// (indistinguishable for speech, a third of the bytes), one request per
// utterance with the caller fetching the next while one plays.
import Foundation

public enum ElevenLabs {
    public static let model = "eleven_flash_v2_5"
    static let format = "mp3_44100_64"
    static let api = URL(string: "https://api.elevenlabs.io/v1")!
    /// George: a premade voice every account has, used when nothing is chosen.
    public static let defaultVoiceId = "JBFqnCBsd6RMkjVDRZzb"

    public struct Voice: Identifiable, Hashable, Sendable {
        public let id: String
        public let name: String
        public let detail: String?
    }

    public struct Failure: LocalizedError, Sendable {
        public let status: Int?
        public let message: String
        public var errorDescription: String? { message }
    }

    // MARK: - Requests

    public static func speechRequest(text: String, voiceId: String, key: String) throws -> URLRequest {
        let segment = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        var components = URLComponents(url: api, resolvingAgainstBaseURL: false)!
        let escaped = voiceId.addingPercentEncoding(withAllowedCharacters: segment) ?? voiceId
        components.percentEncodedPath += "/text-to-speech/\(escaped)"
        components.queryItems = [URLQueryItem(name: "output_format", value: format)]
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "model_id": model])
        return request
    }

    public static func voicesRequest(key: String) -> URLRequest {
        var request = URLRequest(url: api.appendingPathComponent("voices"))
        request.timeoutInterval = 20
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        return request
    }

    // MARK: - Calls

    /// MP3 audio for one utterance.
    public static func speech(text: String, voiceId: String, key: String, session: URLSession = .shared) async throws -> Data {
        let (data, response) = try await session.data(for: try speechRequest(text: text, voiceId: voiceId, key: key))
        try check(response, data)
        return data
    }

    /// The account's voices. Also the key check: it is exactly the scope
    /// Walkie needs, where a `/user` check would reject restricted keys.
    public static func voices(key: String, session: URLSession = .shared) async throws -> [Voice] {
        let (data, response) = try await session.data(for: voicesRequest(key: key))
        try check(response, data)
        return try decodeVoices(data)
    }

    static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw Failure(status: nil, message: "ElevenLabs didn't answer.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Failure(status: http.statusCode, message: errorMessage(status: http.statusCode, body: data))
        }
    }

    // MARK: - Decoding

    public static func decodeVoices(_ data: Data) throws -> [Voice] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        let list = root["voices"] as? [[String: Any]] ?? []
        return list.compactMap { voice in
            guard let id = voice["voice_id"] as? String, !id.isEmpty else { return nil }
            let labels = voice["labels"] as? [String: Any]
            let detail = [labels?["accent"] as? String, labels?["description"] as? String]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            return Voice(id: id, name: voice["name"] as? String ?? "Voice", detail: detail.isEmpty ? nil : detail)
        }
    }

    /// ElevenLabs' own words where it gives them — it knows the plan, the
    /// quota and the voice — and a next step where it does not.
    public static func errorMessage(status: Int, body: Data?) -> String {
        var theirs = ""
        if let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let detail = object["detail"] as? String {
                theirs = detail
            } else if let detail = object["detail"] as? [String: Any], let message = detail["message"] as? String {
                theirs = message
            } else if let message = object["message"] as? String {
                theirs = message
            }
        }
        theirs = theirs.trimmingCharacters(in: .whitespacesAndNewlines)
        switch status {
        case 401, 403:
            return "ElevenLabs rejected that key. If it's a restricted key, give it the Voices and Text to Speech permissions, or paste an unrestricted one."
        case 402:
            return theirs.isEmpty ? "ElevenLabs says this account is out of credit." : "ElevenLabs: \(theirs)"
        case 429:
            return theirs.isEmpty ? "ElevenLabs is rate-limiting this account. Wait a moment and try again." : "ElevenLabs: \(theirs)"
        default:
            return theirs.isEmpty ? "ElevenLabs couldn't speak that (\(status))." : "ElevenLabs: \(theirs)"
        }
    }
}
