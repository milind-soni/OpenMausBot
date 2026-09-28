import XCTest
@testable import CompanionCore

final class VoiceNoteTests: XCTestCase {
    func testDecodesAudioAttachmentsAlongsideImagesAndUnknownKinds() throws {
        let json = #"{"id":"m1","role":"bot","kind":"text","at":1,"text":"Spoken summary","attachments":[{"kind":"audio","path":"note-1744.mp3","mime":"audio/mpeg","durationMs":2400},{"kind":"image","path":"shot-1.png","mime":"image/png"},{"kind":"video","path":"clip-9.mov"}]}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))

        XCTAssertEqual(message.voiceNotes.count, 1)
        let note = try XCTUnwrap(message.voiceNotes.first)
        XCTAssertEqual(note.path, "note-1744.mp3")
        XCTAssertEqual(note.mime, "audio/mpeg")
        XCTAssertEqual(note.durationMs, 2400)
        XCTAssertEqual(message.generatedImages.map { $0.path }, ["shot-1.png"])
    }

    func testVoiceNotesSkipEmptyPathsAndDeduplicateReplays() throws {
        let json = #"{"id":"m2","role":"bot","kind":"text","at":2,"attachments":[{"kind":"audio","path":"note-1744.mp3"},{"kind":"audio","path":"note-1744.mp3","durationMs":2400},{"kind":"audio","path":"   "}]}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))

        XCTAssertEqual(message.voiceNotes.count, 1)
        XCTAssertNil(message.voiceNotes.first?.durationMs)
    }

    func testAudioAttachmentRoundTripsThroughTheWireShape() throws {
        let attachment = MessageImageAttachment(kind: "audio", path: "note-1744.mp3", mime: "audio/mpeg", durationMs: 2400)
        let encoder = JSONEncoder()
        let decoded = try JSONDecoder().decode(MessageImageAttachment.self, from: try encoder.encode(attachment))
        XCTAssertEqual(decoded, attachment)
    }

    func testVoiceNoteFileNameAcceptsOnlyGeneratedMp3Names() {
        XCTAssertEqual(CompanionClient.voiceNoteFileName("note-1744.mp3"), "note-1744.mp3")
        XCTAssertEqual(
            CompanionClient.voiceNoteFileName("/api/attachments/note-1744.mp3"),
            "note-1744.mp3"
        )
        // Directory parts are dropped, mirroring the web bubble's basename
        // step; the route still only ever resolves inside its attachment dir.
        XCTAssertEqual(CompanionClient.voiceNoteFileName("replays/note-1744.mp3"), "note-1744.mp3")

        XCTAssertNil(CompanionClient.voiceNoteFileName("note.mp4"))
        XCTAssertNil(CompanionClient.voiceNoteFileName("note.mp3.exe"))
        XCTAssertNil(CompanionClient.voiceNoteFileName("two.words.mp3"))
        XCTAssertNil(CompanionClient.voiceNoteFileName(".mp3"))
        XCTAssertNil(CompanionClient.voiceNoteFileName(""))
        XCTAssertNil(CompanionClient.voiceNoteFileName("note 1744.mp3"))
        XCTAssertNil(CompanionClient.voiceNoteFileName("/api/attachments/"))
    }
}
