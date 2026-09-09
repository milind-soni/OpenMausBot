import XCTest
@testable import CompanionCore

final class AttachedMessageContentTests: XCTestCase {
    func testSplitsSharedImagesAndNamedFilesFromVisibleText() {
        let parsed = AttachedMessageContent.parse("""
        Please review these.

        <attached-image path="/tmp/photo.png" />

        <attached-file path="/tmp/4ad3.pdf" name="Project &amp; notes.pdf" />
        """)

        XCTAssertEqual(parsed.text, "Please review these.")
        XCTAssertEqual(parsed.attachments, [
            DisplayedMessageAttachment(kind: .image, path: "/tmp/photo.png", name: "photo.png"),
            DisplayedMessageAttachment(
                kind: .file,
                path: "/tmp/4ad3.pdf",
                name: "Project & notes.pdf"
            ),
        ])
    }

    func testFallsBackToBasenameForOlderFileTags() {
        let parsed = AttachedMessageContent.parse(
            #"<attached-file path="C:\Users\Maus\brief.docx" />"#
        )

        XCTAssertEqual(parsed.text, "")
        XCTAssertEqual(parsed.attachments, [
            DisplayedMessageAttachment(
                kind: .file,
                path: #"C:\Users\Maus\brief.docx"#,
                name: "brief.docx"
            ),
        ])
    }

    func testLeavesInlineExamplesAndUnrelatedTagsVisible() {
        let source = "Example: <attached-file path=\"/tmp/demo.pdf\" />\n<pasted-text>hello</pasted-text>"
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.text, source)
        XCTAssertTrue(parsed.attachments.isEmpty)
    }

    func testLeavesFencedAndIndentedAttachmentExamplesVisible() {
        let source = """
        ```xml
        <attached-file path="/tmp/fenced.pdf" />
        ```
            <attached-image path="/tmp/spaces.png" />
        \t<attached-file path="/tmp/tab.md" />
        <attached-file path="/tmp/real.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.attachments.map(\.path), ["/tmp/real.md"])
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/fenced.pdf" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-image path="/tmp/spaces.png" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/tab.md" />"#))
    }

    func testUnclosedStreamingFenceKeepsTransportLookingLinesLiteral() {
        let source = """
        Before
        ~~~
        <attached-file path="/tmp/not-transport.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.text, source)
        XCTAssertTrue(parsed.attachments.isEmpty)
    }

    func testLeavesAttachmentExamplesInsideHTMLContextsVisible() {
        let source = """
        <!--
        <attached-file path="/tmp/comment.md" />
        -->
        <div class="example">
        <attached-image path="/tmp/div.png" />
        </div>

        <pasted-text>
        <attached-file path="/tmp/paste.pdf" />
        </pasted-text>
        <attached-file path="/tmp/real.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.attachments.map(\.path), ["/tmp/real.md"])
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/comment.md" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-image path="/tmp/div.png" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/paste.pdf" />"#))
    }

    func testKeepsPreBlocksThroughClosingTagAcrossBlankLines() {
        let source = """
        <pre class="example">
        <attached-file path="/tmp/in-pre.md" />

        </pre>
        <attached-file path="/tmp/real.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.attachments.map(\.path), ["/tmp/real.md"])
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/in-pre.md" />"#))
    }

    func testKeepsTableAndNestedSectionBlocksThroughBlankLine() {
        let source = """
        <table>
        <attached-file path="/tmp/in-table.csv" />
        </table>

        <section aria-label="example">
        <div>
        <attached-image path="/tmp/in-nested-div.png" />
        </div>
        </section>
        <attached-file path="/tmp/still-html.md" />

        <attached-file path="/tmp/real.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.attachments.map(\.path), ["/tmp/real.md"])
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/in-table.csv" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-image path="/tmp/in-nested-div.png" />"#))
        XCTAssertTrue(parsed.text.contains(#"<attached-file path="/tmp/still-html.md" />"#))
    }

    func testKeepsSpecialAndGenericHTMLBlocksLiteral() {
        let source = """
        <?example
        <attached-file path="/tmp/in-pi.md" />
        ?>
        <![CDATA[
        <attached-file path="/tmp/in-cdata.md" />
        ]]>
        <!example
        <attached-file path="/tmp/in-declaration.md" />
        >
        <widget data-name="example">
        <attached-file path="/tmp/in-generic.md" />
        </widget>

        <attached-file path="/tmp/real.md" />
        """
        let parsed = AttachedMessageContent.parse(source)

        XCTAssertEqual(parsed.attachments.map(\.path), ["/tmp/real.md"])
        for name in ["in-pi.md", "in-cdata.md", "in-declaration.md", "in-generic.md"] {
            XCTAssertTrue(parsed.text.contains(name))
        }
    }

    func testBoundsAndFlattensUntrustedDisplayNames() {
        let longName = "\u{202E}" + String(repeating: "a", count: 200) + "\n.pdf"
        let parsed = AttachedMessageContent.parse(
            "<attached-file path=\"/tmp/file.pdf\" name=\"\(longName.replacingOccurrences(of: "\n", with: "&#10;"))\" />"
        )

        XCTAssertEqual(parsed.attachments.count, 1)
        XCTAssertEqual(parsed.attachments[0].name.count, 180)
        XCTAssertFalse(parsed.attachments[0].name.contains("\n"))
        XCTAssertFalse(parsed.attachments[0].name.contains("\u{202E}"))
    }

    func testRetainsDecodedPathForAuthenticatedPreviewRequest() throws {
        let parsed = AttachedMessageContent.parse(
            #"<attached-image path="/tmp/Photos &amp; Files/a&amp;b.png" />"#
        )

        let attachment = try XCTUnwrap(parsed.attachments.first)
        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.path, "/tmp/Photos & Files/a&b.png")
        XCTAssertEqual(attachment.name, "a&b.png")
    }

    func testUsesOriginalNameFromNewImageTags() throws {
        let parsed = AttachedMessageContent.parse(
            #"<attached-image path="/tmp/9fd2.png" name="Launch &amp; hero.png" />"#
        )

        let attachment = try XCTUnwrap(parsed.attachments.first)
        XCTAssertEqual(attachment.path, "/tmp/9fd2.png")
        XCTAssertEqual(attachment.name, "Launch & hero.png")
    }

    func testBasenamesProvidedDisplayName() throws {
        let parsed = AttachedMessageContent.parse(
            #"<attached-file path="/tmp/9fd2.pdf" name="../private/Project.pdf" />"#
        )

        let attachment = try XCTUnwrap(parsed.attachments.first)
        XCTAssertEqual(attachment.path, "/tmp/9fd2.pdf")
        XCTAssertEqual(attachment.name, "Project.pdf")
    }
}
