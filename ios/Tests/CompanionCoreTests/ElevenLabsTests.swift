import XCTest
@testable import CompanionCore

final class ElevenLabsTests: XCTestCase {
    func testSpeechRequestAsksForFlashMp3WithTheKeyInAHeader() throws {
        let request = try ElevenLabs.speechRequest(text: "Canvas one passed.", voiceId: "JBFqnCBsd6RMkjVDRZzb", key: "sk_test")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_64"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "xi-api-key"), "sk_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "accept"), "audio/mpeg")
        XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["text": "Canvas one passed.", "model_id": "eleven_flash_v2_5"])
        XCTAssertNil(request.url?.query?.range(of: "sk_test"), "the key never goes in the URL")
    }

    func testVoiceIdsAreEscapedIntoThePath() throws {
        let request = try ElevenLabs.speechRequest(text: "Hi", voiceId: "a/b c", key: "k")
        XCTAssertEqual(request.url?.path, "/v1/text-to-speech/a/b c")
        XCTAssertTrue(request.url?.absoluteString.contains("a%2Fb%20c") == true)
    }

    func testVoicesRequestCarriesTheKey() {
        let request = ElevenLabs.voicesRequest(key: "sk_test")
        XCTAssertEqual(request.url?.absoluteString, "https://api.elevenlabs.io/v1/voices")
        XCTAssertEqual(request.value(forHTTPHeaderField: "xi-api-key"), "sk_test")
    }

    func testDecodesVoicesWithTheirAccent() throws {
        let data = Data("""
        {"voices":[
          {"voice_id":"JBFqnCBsd6RMkjVDRZzb","name":"George","labels":{"accent":"british","description":"warm"}},
          {"voice_id":"","name":"Broken"},
          {"voice_id":"EXAVITQu4vr4xnSDxMaL","name":"Sarah"}
        ]}
        """.utf8)
        let voices = try ElevenLabs.decodeVoices(data)
        XCTAssertEqual(voices.map(\.id), ["JBFqnCBsd6RMkjVDRZzb", "EXAVITQu4vr4xnSDxMaL"])
        XCTAssertEqual(voices.first?.name, "George")
        XCTAssertEqual(voices.first?.detail, "british · warm")
        XCTAssertNil(voices.last?.detail)
    }

    func testRejectedKeysGetAnActionableMessage() {
        XCTAssertTrue(ElevenLabs.errorMessage(status: 401, body: nil).contains("rejected that key"))
        XCTAssertTrue(ElevenLabs.errorMessage(status: 403, body: nil).contains("Text to Speech"))
    }

    func testPrefersElevenLabsOwnWords() {
        let body = Data(#"{"detail":{"status":"quota_exceeded","message":"You have 12 credits left."}}"#.utf8)
        XCTAssertEqual(ElevenLabs.errorMessage(status: 400, body: body), "ElevenLabs: You have 12 credits left.")
        XCTAssertEqual(ElevenLabs.errorMessage(status: 402, body: nil), "ElevenLabs says this account is out of credit.")
        XCTAssertEqual(ElevenLabs.errorMessage(status: 500, body: nil), "ElevenLabs couldn't speak that (500).")
    }
}
