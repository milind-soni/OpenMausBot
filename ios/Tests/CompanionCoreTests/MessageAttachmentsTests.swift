import Foundation
import XCTest
@testable import CompanionCore

final class MessageAttachmentsTests: XCTestCase {
    func testClassifiesWebAndAbsoluteDesktopLinks() throws {
        let web = try XCTUnwrap(LocalMessageLink.resolve("https://example.com/report.md?q=1"))
        XCTAssertEqual(web, .web(try XCTUnwrap(URL(string: "https://example.com/report.md?q=1"))))
        XCTAssertEqual(
            LocalMessageLink.resolve("/Users/milind/Documents/report.md"),
            .desktopFile(path: "/Users/milind/Documents/report.md")
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("file:///Users/milind/My%20Report.md"),
            .desktopFile(path: "/Users/milind/My Report.md")
        )
        XCTAssertEqual(
            LocalMessageLink.resolve(#"C:\Users\Milind\report.md"#),
            .desktopFile(path: #"C:\Users\Milind\report.md"#)
        )
        XCTAssertEqual(
            LocalMessageLink.resolve(try XCTUnwrap(URL(string: #"C:\Users\Milind\report.md"#))),
            .desktopFile(path: #"C:\Users\Milind\report.md"#)
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("file:///C:/Users/Milind/report.md"),
            .desktopFile(path: "C:/Users/Milind/report.md")
        )
        XCTAssertEqual(
            LocalMessageLink.resolve(#"\\server\share\report.md"#),
            .desktopFile(path: #"\\server\share\report.md"#)
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("file://server/share/report.md"),
            .desktopFile(path: #"\\server\share\report.md"#)
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("//files.example.com/report.md"),
            .web(try XCTUnwrap(URL(string: "https://files.example.com/report.md")))
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("docs/My Report.md"),
            .desktopFile(path: "docs/My Report.md")
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("./reports/Quarter%20One.md?download=1#latest"),
            .desktopFile(path: "./reports/Quarter One.md")
        )
        XCTAssertEqual(
            LocalMessageLink.resolve("/C:/posix/report.md"),
            .desktopFile(path: "/C:/posix/report.md")
        )
    }

    func testRejectsMalformedEmptyAndCustomSchemeLinks() {
        XCTAssertNil(LocalMessageLink.resolve("#section"))
        XCTAssertNil(LocalMessageLink.resolve("?download=1"))
        XCTAssertNil(LocalMessageLink.resolve("openmausbot://pair?token=secret"))
        XCTAssertNil(LocalMessageLink.resolve("javascript:alert(1)"))
        XCTAssertNil(LocalMessageLink.resolve("https:///missing-host.md"))
        XCTAssertNil(LocalMessageLink.resolve("file:///tmp/report.md?replace=1"))
        XCTAssertNil(LocalMessageLink.resolve("docs/bad%ZZ.md"))
        XCTAssertNil(LocalMessageLink.resolve("/tmp/bad\0name.md"))
    }

    func testAttachmentPolicyAcceptsSupportedImageAndMarkdown() throws {
        let attachments = [
            PendingMessageAttachment(
                data: Data([0x89, 0x50]),
                name: "photo.png",
                mime: "IMAGE/PNG; charset=binary",
                kind: .image
            ),
            PendingMessageAttachment(
                data: Data("# Notes".utf8),
                name: "notes.md",
                mime: "text/markdown",
                kind: .file
            ),
        ]

        XCTAssertNoThrow(try AttachmentPolicy.validate(attachments))
        XCTAssertEqual(AttachmentPolicy.kind(forMIME: " IMAGE/JPEG "), .image)
        XCTAssertEqual(AttachmentPolicy.kind(forMIME: "application/pdf"), .file)
        XCTAssertNil(AttachmentPolicy.kind(forMIME: "application/zip"))
    }

    func testAttachmentPolicyRejectsCountTypeNameAndSize() {
        let valid = PendingMessageAttachment(
            data: Data([1]), name: "notes.txt", mime: "text/plain", kind: .file
        )
        XCTAssertThrowsError(try AttachmentPolicy.validate(Array(repeating: valid, count: 5))) {
            XCTAssertEqual($0 as? AttachmentPolicyError, .tooManyItems)
        }
        XCTAssertThrowsError(try AttachmentPolicy.validate([
            PendingMessageAttachment(data: Data([1]), name: "archive.zip", mime: "application/zip", kind: .file),
        ])) {
            XCTAssertEqual($0 as? AttachmentPolicyError, .unsupportedType("archive.zip"))
        }
        XCTAssertThrowsError(try AttachmentPolicy.validate([
            PendingMessageAttachment(data: Data([1]), name: "../notes.txt", mime: "text/plain", kind: .file),
        ])) {
            XCTAssertEqual($0 as? AttachmentPolicyError, .invalidName)
        }
        XCTAssertThrowsError(try AttachmentPolicy.validate([
            PendingMessageAttachment(
                data: Data(repeating: 0, count: AttachmentPolicy.maximumImageBytes + 1),
                name: "huge.png",
                mime: "image/png",
                kind: .image
            ),
        ])) {
            XCTAssertEqual($0 as? AttachmentPolicyError, .itemTooLarge(name: "huge.png", limitMB: 10))
        }
    }
}
