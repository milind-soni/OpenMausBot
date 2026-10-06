// The block splitter.
//
// The view half — fonts, bullets, the caret — needs a simulator to judge and
// is not tested here. The split is the part with decisions in it, and every
// decision below is one the desktop's react-markdown + remark-gfm already
// made, so the two clients wrap the same reply the same way.
//
// The streaming cases matter most. Every one of these strings is a state the
// phone renders for real, several times a second, on the way to a finished
// reply: half a fence, half a bold run, a bullet with nothing after it. A
// parser that throws away input in those states makes text flicker.
import XCTest
@testable import CompanionCore

final class MarkdownTests: XCTestCase {
    func testCachedParseReusesContentWithoutSharingMutableResults() throws {
        let source = "# Cache regression\n\n- **styled** [link](https://example.test)\n\n```swift\nlet n = 1"
        let key = source as NSString
        Markdown.blockCache.removeObject(forKey: key)
        var first = Markdown.blocks(source)
        let cached = try XCTUnwrap(Markdown.blockCache.object(forKey: key))
        let expected = first
        first[0] = .paragraph("changed by the caller")
        XCTAssertEqual(Markdown.blocks(source), expected)
        XCTAssertTrue(Markdown.blockCache.object(forKey: key) === cached)
        XCTAssertNotEqual(Markdown.blocks(source + "\nlet n = 2"), expected)

        Markdown.blockCache.removeObject(forKey: key)
        XCTAssertEqual(Markdown.blocks(source), expected)
        XCTAssertFalse(Markdown.blockCache.object(forKey: key) === cached)
    }

    func testLargeUnicodeReplyIsNotRetainedInParseCache() {
        let source = String(repeating: "🐭", count: 20_000)
        XCTAssertEqual(Markdown.blocks(source), [.paragraph(source)])
        XCTAssertNil(Markdown.blockCache.object(forKey: source as NSString))
    }

    func testPlainTextIsOneParagraph() {
        XCTAssertEqual(Markdown.blocks("just a reply"), [.paragraph("just a reply")])
    }

    func testEmptyInputProducesNothing() {
        XCTAssertEqual(Markdown.blocks(""), [])
        XCTAssertEqual(Markdown.blocks("\n\n  \n"), [])
    }

    /// GFM without `breaks`, which is how the desktop is configured: a lone
    /// newline is a soft break and renders as a space. Joining with "\n"
    /// instead would wrap differently on the two clients for the same text.
    func testSoftBreaksBecomeSpaces() {
        XCTAssertEqual(
            Markdown.blocks("one line\nand its continuation"),
            [.paragraph("one line and its continuation")]
        )
    }

    func testBlankLineSeparatesParagraphs() {
        XCTAssertEqual(
            Markdown.blocks("first\n\nsecond"),
            [.paragraph("first"), .paragraph("second")]
        )
    }

    // MARK: - Headings

    func testHeadingLevels() {
        XCTAssertEqual(Markdown.blocks("# Title"), [.heading(level: 1, text: "Title")])
        XCTAssertEqual(Markdown.blocks("### Deeper"), [.heading(level: 3, text: "Deeper")])
    }

    /// ATX requires the space. Without this check every "#1 pick" and every
    /// "#hashtag" in a reply becomes a 21pt heading.
    func testHashWithoutSpaceIsNotAHeading() {
        XCTAssertEqual(Markdown.blocks("#hashtag"), [.paragraph("#hashtag")])
        XCTAssertEqual(Markdown.blocks("####### seven"), [.paragraph("####### seven")])
    }

    // MARK: - Lists

    func testBulletMarkers() {
        XCTAssertEqual(
            Markdown.blocks("- one\n* two\n+ three"),
            [
                .bullet(indent: 0, text: "one"),
                .bullet(indent: 0, text: "two"),
                .bullet(indent: 0, text: "three"),
            ]
        )
    }

    func testNestedBulletsCountIndent() {
        XCTAssertEqual(
            Markdown.blocks("- top\n  - nested\n    - deeper"),
            [
                .bullet(indent: 0, text: "top"),
                .bullet(indent: 1, text: "nested"),
                .bullet(indent: 2, text: "deeper"),
            ]
        )
    }

    func testOrderedListsKeepTheirNumbers() {
        XCTAssertEqual(
            Markdown.blocks("1. first\n2. second\n10) tenth"),
            [
                .ordered(indent: 0, number: 1, text: "first"),
                .ordered(indent: 0, number: 2, text: "second"),
                .ordered(indent: 0, number: 10, text: "tenth"),
            ]
        )
    }

    /// A year or a price at the start of a sentence is not a list. The
    /// delimiter is what makes it one.
    func testNumberWithoutDelimiterIsProse() {
        XCTAssertEqual(Markdown.blocks("2026 was the year"), [.paragraph("2026 was the year")])
        XCTAssertEqual(Markdown.blocks("3.14 is pi"), [.paragraph("3.14 is pi")])
    }

    /// Inline emphasis is Foundation's job, not this one — the splitter must
    /// hand the markers through untouched or the view has nothing to render.
    func testInlineSyntaxSurvivesTheSplit() {
        XCTAssertEqual(
            Markdown.blocks("- **bold** and `code` and [link](https://x.test)"),
            [.bullet(indent: 0, text: "**bold** and `code` and [link](https://x.test)")]
        )
    }

    // MARK: - Fences

    func testFencedCodeKeepsItsLanguageAndItsWhitespace() {
        XCTAssertEqual(
            Markdown.blocks("```swift\nlet x = 1\n    indented\n```"),
            [.code(language: "swift", text: "let x = 1\n    indented")]
        )
    }

    func testFenceWithoutLanguage() {
        XCTAssertEqual(Markdown.blocks("```\nplain\n```"), [.code(language: nil, text: "plain")])
    }

    /// Mid-stream, a fence is open for as long as the snippet takes to
    /// arrive. Rendering it as code from the first line means the block grows
    /// downward; waiting for the closing fence means three backticks sit on
    /// screen and then the whole thing reflows at once.
    func testUnclosedFenceRunsToTheEnd() {
        XCTAssertEqual(
            Markdown.blocks("here:\n```py\nprint(1)"),
            [.paragraph("here:"), .code(language: "py", text: "print(1)")]
        )
    }

    /// Markers inside a fence are code, not structure.
    func testFenceContentIsNotReparsed() {
        XCTAssertEqual(
            Markdown.blocks("```\n# not a heading\n- not a bullet\n```"),
            [.code(language: nil, text: "# not a heading\n- not a bullet")]
        )
    }

    // MARK: - Quotes and rules

    func testQuote() {
        XCTAssertEqual(Markdown.blocks("> quoted"), [.quote("quoted")])
    }

    func testHorizontalRules() {
        XCTAssertEqual(Markdown.blocks("---"), [.rule])
        XCTAssertEqual(Markdown.blocks("***"), [.rule])
        XCTAssertEqual(Markdown.blocks("___"), [.rule])
    }

    /// Two hyphens are not a rule, and "- " is a bullet regardless.
    func testRuleNeedsThreeAndNothingElse() {
        XCTAssertEqual(Markdown.blocks("--"), [.paragraph("--")])
        XCTAssertEqual(Markdown.blocks("-- dashes --"), [.paragraph("-- dashes --")])
    }

    // MARK: - Streaming

    /// The invariant that keeps the bubble from flickering: whatever arrives,
    /// something renders, and the characters the model has sent are in it.
    func testPartialInputAlwaysRendersSomething() {
        for prefix in ["#", "# ", "# Head", "- ", "- it", "**bo", "```", "```sw\nlet", "[link](htt"] {
            XCTAssertFalse(
                Markdown.blocks(prefix).isEmpty,
                "dropped everything for \(prefix.debugDescription)"
            )
        }
    }

    /// Growing the source one character at a time must never lose text. This
    /// is the whole stream, replayed at the granularity the deltas arrive at.
    func testNoPrefixOfAReplyLosesCharacters() {
        let reply = "# Result\n\nRan **two** checks:\n\n- `pnpm test` passed\n- `pnpm lint` passed\n\n```sh\npnpm test\n```\n\n> nothing else to report"
        for length in 1...reply.count {
            let partial = String(reply.prefix(length))
            let rendered = Markdown.blocks(partial).map(text).joined()
            // Compare on non-whitespace: the splitter deliberately drops
            // markers, indentation and blank lines, and it joins soft breaks
            // with a space. What it must not drop is content.
            let sent = partial.filter { !$0.isWhitespace && !"#->`*_".contains($0) }
            let shown = rendered.filter { !$0.isWhitespace && !"#->`*_".contains($0) }
            XCTAssertEqual(shown, sent, "lost content at \(length) characters")
        }
    }

    // MARK: - Streaming parse

    /// The live bubble asks for the blocks of a longer text every 50 ms and
    /// gets the settled ones from the last update plus a parse of the rest.
    /// Whatever the split, that must equal parsing the whole text at once —
    /// at every point a delta can end, including between "\r" and "\n" and
    /// between a letter and its combining accent.
    func testStreamingParseMatchesOneShotParseAtEveryPrefix() {
        Markdown.settledPrefixes.removeAll()
        var resumed = 0
        for (name, reply) in Self.streamingCorpus {
            for step in [1, 3, 20] {
                resumed += stream(reply, step: step, name: name)
            }
        }
        let long = Self.longReply(sections: 2)
        resumed += stream(long, step: 9, name: "long")
        resumed += stream(long.replacingOccurrences(of: "\n", with: "\r\n"), step: 20, name: "long CRLF")
        // A test that never resumes from a settled prefix proves nothing.
        XCTAssertGreaterThan(resumed, 500)
    }

    /// Two replies that start the same way must not borrow each other's
    /// settled blocks past the point where they differ. Here the first
    /// reply's table ended because the table looked at "end" and found no
    /// row; the second reply has a row there. The first reply's settled
    /// prefix has to include the line the table looked at, or the second
    /// reply would resume after the table and lose its rows.
    func testRepliesSharingAPrefixDoNotShareTheirEnding() {
        Markdown.settledPrefixes.removeAll()
        let first = "Intro\n\n| A | B |\n| --- | --- |\nend\nof the same paragraph"
        let second = "Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter"
        let third = "Intro\n\n```\ncode\n\nstill code\n```\n\nafter"
        _ = stream(first, step: 2, name: "first")
        XCTAssertEqual(Markdown.settledPrefixes.count, 1)
        _ = stream(second, step: 2, name: "second")
        _ = stream(first, step: 5, name: "first again")
        _ = stream(third, step: 1, name: "third")
        // A reply replaced mid-stream by a different one.
        for text in [first, "Intro\n\nsomething else entirely", second, "Intro"] {
            XCTAssertEqual(Markdown.blocks(text, streaming: true), Markdown.blocksFromScratch(text), text.debugDescription)
        }
    }

    /// The old cost was the whole text on every update, so a 3,000-word
    /// reply sent in 20-character steps put about 460 bytes through the
    /// parser for every byte of the reply, and twice the reply cost four
    /// times as much. Now a byte is parsed again only while the block it
    /// sits in is still open: about 15 bytes per byte here (the open fence,
    /// table or list is re-read each step), and twice the reply costs twice
    /// as much.
    func testStreamingParseWorkIsLinearInTheReply() {
        func cost(_ reply: String) -> (new: Int, old: Int) {
            Markdown.settledPrefixes.removeAll()
            var new = 0
            var old = 0
            Self.forEachPrefix(of: reply, every: 20) { prefix in
                new += Markdown.parse(prefix, streaming: true).parsedUTF8
                // What the old full-text cache did with a prefix it had
                // never seen: parse all of it.
                old += prefix.utf8.count
            }
            return (new, old)
        }
        let reply = Self.longReply(sections: 8)
        let double = reply + "\n\n" + Self.longReply(sections: 8, salt: 1)
        let words = reply.split(whereSeparator: \.isWhitespace).count
        XCTAssertGreaterThan(words, 2_800)
        XCTAssertLessThan(words, 3_400)

        let single = cost(reply)
        let twice = cost(double)
        let length = reply.utf8.count
        let summary = "\(words) words, \(length) bytes: parsed \(single.new) (was \(single.old)); twice the reply \(twice.new) (was \(twice.old))"
        // A small multiple of the reply, not of its square.
        XCTAssertLessThan(single.new, 20 * length, summary)
        XCTAssertGreaterThan(single.old, 200 * length, summary)
        XCTAssertGreaterThan(single.old / single.new, 15, summary)
        let newGrowth = Double(twice.new) / Double(single.new)
        let oldGrowth = Double(twice.old) / Double(single.old)
        XCTAssertLessThan(newGrowth, 2.5, summary)
        XCTAssertGreaterThan(oldGrowth, 3.5, summary)
    }

    /// Streaming used to put every prefix of the live reply into the same
    /// bounded cache as finished messages, so one long reply pushed the
    /// whole visible transcript out. Now the prefixes stay out of it, and the
    /// reply keeps a single settled-prefix entry rather than one per update.
    func testStreamingDoesNotEvictSettledMessages() throws {
        let settled = "# Earlier reply\n\n- kept in the cache\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"
        let settledKey = settled as NSString
        Markdown.blockCache.removeObject(forKey: settledKey)
        _ = Markdown.blocks(settled)
        let cached = try XCTUnwrap(Markdown.blockCache.object(forKey: settledKey))

        Markdown.settledPrefixes.removeAll()
        let reply = Self.longReply(sections: 6, salt: 2)
        var prefixes: [String] = []
        Self.forEachPrefix(of: reply, every: 20) { prefix in
            prefixes.append(prefix)
            _ = Markdown.blocks(prefix, streaming: true)
        }
        XCTAssertGreaterThan(prefixes.count, 300)
        XCTAssertTrue(Markdown.blockCache.object(forKey: settledKey) === cached)
        XCTAssertNil(prefixes.first { Markdown.blockCache.object(forKey: $0 as NSString) != nil })
        XCTAssertEqual(Markdown.settledPrefixes.count, 1)

        // When the reply settles, its final text parses only what came after
        // the last settled block, and is cached like any finished message.
        let final = Markdown.parse(reply, streaming: false)
        XCTAssertEqual(final.blocks, Markdown.blocksFromScratch(reply))
        XCTAssertLessThan(final.parsedUTF8, reply.utf8.count / 4)
        XCTAssertNotNil(Markdown.blockCache.object(forKey: reply as NSString))
    }

    /// Feeds `reply` to the streaming parse in `step`-scalar deltas and
    /// checks every intermediate result. Returns how many updates resumed
    /// from a settled prefix.
    private func stream(_ reply: String, step: Int, name: String) -> Int {
        var resumed = 0
        var failed = false
        Self.forEachPrefix(of: reply, every: step, byScalar: true) { prefix in
            guard !failed else { return }
            let parsed = Markdown.parse(prefix, streaming: true)
            if parsed.parsedUTF8 > 0, parsed.parsedUTF8 < prefix.utf8.count { resumed += 1 }
            let expected = Markdown.blocksFromScratch(prefix)
            if parsed.blocks != expected {
                failed = true
                XCTFail("\(name), step \(step), at \(prefix.unicodeScalars.count) scalars: \(prefix.debugDescription)\nstreamed: \(parsed.blocks)\nwhole:    \(expected)")
            }
        }
        return resumed
    }

    /// The text as the phone holds it after each delta of `step` characters,
    /// or of `step` Unicode scalars, which can end between "\r" and "\n" or
    /// between a letter and its combining accent.
    private static func forEachPrefix(of reply: String, every step: Int, byScalar: Bool = false, _ body: (String) -> Void) {
        if byScalar {
            let scalars = reply.unicodeScalars
            var end = scalars.startIndex
            while end < scalars.endIndex {
                end = scalars.index(end, offsetBy: step, limitedBy: scalars.endIndex) ?? scalars.endIndex
                body(String(Substring(scalars[..<end])))
            }
        } else {
            var end = reply.startIndex
            while end < reply.endIndex {
                end = reply.index(end, offsetBy: step, limitedBy: reply.endIndex) ?? reply.endIndex
                body(String(reply[..<end]))
            }
        }
    }

    private static let streamingCorpus: [(String, String)] = [
        ("prose", "First paragraph with **bold** and a [link](https://x.test).\nIt wraps here.\n\nSecond one.\n\n\nThird after two blanks."),
        ("fences", "Before:\n\n```swift\nlet a = 1\n\n// a blank line inside the fence\n# not a heading\n```\n\n~~~\ntilde fence\n```\nstill tilde\n~~~\nAfter the fence\n\n```py\nunclosed(\n\nstill code"),
        ("tables", "Lead-in prose\n| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 | 5 |\nAfter\n\n| A | B | |---|---| | 1 | 2 | | 3 |\n\nPros | Cons\n---\n\n| x | y |\n| - | - |\n\n| z |"),
        ("lists", "- top\n  - nested\n    - deeper\n- [x] done\n- [ ] open\n1. one\n2) two\n   continuation line\n\n- after blank\n# Heading closes it\n- again\n  > quoted inside\n  ```\n  fenced in a list\n  ```\n  - still nested"),
        ("quotes and rules", "> one\n> two\n>\n> three\n\n---\n***\n___\n--\nSetext-looking\n===\n\nTitle\n---\nend"),
        ("headings", "# One\n## Two\n### Three\n#hashtag\n####### seven\nplain\n# After plain\n\n## Last"),
        ("CRLF", "Line one\r\nline two\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n\r\nmore\r\n```\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\nend\r\n"),
        ("lone CR", "Old Mac\rline\r\rnext para\r\r- item\r\r```\rcode\r```\r\rend"),
        ("unicode", "Café 🐭 naïve\n\n👩‍💻 typing e\u{301} and 🇺🇸🇬🇧\n\n- 日本語の箇条書き\n- emoji 🧑🏽‍🚀 item\n\n| 名前 | 状態 |\n| --- | --- |\n| ねずみ | ✅ |\n\n\u{301}starts with a mark\n\nCR then mark\r\u{301}stays on the line\n\nlast 🐭"),
        ("indent and tabs", "    indented code-looking\n    | A | B |\n    | --- | --- |\n\n\t| A | B |\n\t| --- | --- |\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n\nend"),
    ]

    /// A long agent reply: headings, paragraphs with inline markup, nested
    /// lists and tasks, a fenced block with blank lines, a table, a quote
    /// and a rule per section. About 250 words a section.
    static func longReply(sections: Int, salt: Int = 0) -> String {
        let words = ["the", "parser", "**settled**", "`blocks`", "reply", "streams", "in", "batches", "and",
                     "[docs](https://example.test/a)", "café", "🐭", "e\u{301}", "*soft*", "~~old~~", "a|b", "12", "日本語"]
        var index = salt * 7
        func phrase(_ count: Int) -> String {
            (0..<count).map { _ in
                index += 5
                return words[index % words.count]
            }.joined(separator: " ")
        }
        var out = "Here is what I found after reading the code.\n\n"
        for section in 1...sections {
            out += "## \(section). About \(phrase(3))\n\n"
            out += phrase(45) + "\n" + phrase(20) + "\n\n" + phrase(40) + "\n\n"
            out += "- first point: \(phrase(10))\n- second: \(phrase(8))\n  - nested \(phrase(6))\n  - nested again\n"
            out += "- [x] done item\n- [ ] open item\n\n1. step one \(phrase(6))\n2. step two\n3) step three \(phrase(5))\n\n"
            out += "```swift\n"
            for line in 0..<12 {
                out += "    let value\(line) = compute(\(line)) // \(phrase(4))\n"
                if line == 5 { out += "\n" }
            }
            out += "```\n\n| Name | Status | Notes |\n| :--- | :---: | ---: |\n"
            for row in 0..<5 { out += "| row \(row) | `ok` | \(phrase(4)) |\n" }
            out += "\n> Note: \(phrase(15))\n> second quoted line\n\n---\n\n"
        }
        return out + "That is everything."
    }

    private func text(_ block: MarkdownBlock) -> String {
        switch block {
        case let .paragraph(text): return text
        case let .bullet(_, text): return text
        case let .ordered(_, number, text): return "\(number)" + text
        case let .task(_, number, _, text): return (number.map { "\($0)" } ?? "") + text
        case let .heading(_, text): return text
        case let .code(language, text): return (language ?? "") + text
        case let .quote(text): return text
        case .rule: return ""
        case let .table(table): return (table.headers + table.rows.flatMap { $0 }).joined()
        }
    }
}
