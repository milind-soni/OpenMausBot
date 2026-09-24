import XCTest
@testable import CompanionCore

final class MarkdownTableTests: XCTestCase {
    func testProseAroundAMultilineTable() {
        let blocks = Markdown.blocks("Lead-in prose\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter")
        XCTAssertEqual(blocks, [
            .paragraph("Lead-in prose"),
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
            .paragraph("After"),
        ])
    }

    func testWeldedTableAfterProse() {
        let blocks = Markdown.blocks("Lead-in prose\n| A | B | |---|---| | 1 | 2 |\n\nAfter")
        XCTAssertEqual(blocks, [
            .paragraph("Lead-in prose"),
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
            .paragraph("After"),
        ])
    }

    func testWeldedEmptyCellsAndShortTail() {
        let empty = Markdown.blocks("| A | B | |---|---| | | 2 | | | 4 |")
        XCTAssertEqual(empty, [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["", "2"], ["", "4"]])),
        ])
        let short = Markdown.blocks("| A | B | |---|---| | 1 |")
        XCTAssertEqual(short, [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", ""]])),
        ])
    }

    func testMultilineExtraCellGrowsAndWeldedExtraCellWraps() {
        let grown = Markdown.blocks("| A | B |\n| --- | --- |\n| 1 | 2 | 3 |")
        XCTAssertEqual(grown, [
            .table(MarkdownTable(
                headers: ["A", "B", ""],
                alignments: [.leading, .leading, .leading],
                rows: [["1", "2", "3"]]
            )),
        ])
        let wrapped = Markdown.blocks("| A | B | |---|---| | 1 | 2 | 3 |")
        XCTAssertEqual(wrapped, [
            .table(MarkdownTable(
                headers: ["A", "B"],
                alignments: [.leading, .leading],
                rows: [["1", "2"], ["3", ""]]
            )),
        ])
    }

    func testDelimiterWidthAndCenter() {
        let short = Markdown.blocks("| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |")
        XCTAssertEqual(short, [
            .table(MarkdownTable(
                headers: ["A", "B", "C"],
                alignments: [.leading, .leading, .leading],
                rows: [["1", "2", "3"]]
            )),
        ])
        let aligned = Markdown.blocks("| A | B | C |\n| :--- | ---: |\n| 1 | 2 | 3 |")
        XCTAssertEqual(aligned, [
            .table(MarkdownTable(
                headers: ["A", "B", "C"],
                alignments: [.leading, .trailing, .leading],
                rows: [["1", "2", "3"]]
            )),
        ])
        let long = Markdown.blocks("| A | B |\n| --- | --- | --- | --- |\n| 1 | 2 |")
        XCTAssertEqual(long, [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
        ])
        let center = Markdown.blocks("| A |\n| :---: |\n| mid |")
        XCTAssertEqual(center, [
            .table(MarkdownTable(headers: ["A"], alignments: [.center], rows: [["mid"]])),
        ])
    }

    func testEscapesAndCodeSpansDoNotSplitCells() {
        let escaped = Markdown.blocks("| a \\| b | c | d |\n| --- | --- |\n| 1 | 2 | 3 |")
        XCTAssertEqual(escaped, [
            .table(MarkdownTable(
                headers: ["a | b", "c", "d"],
                alignments: [.leading, .leading, .leading],
                rows: [["1", "2", "3"]]
            )),
        ])
        let coded = Markdown.blocks("| `a|b` | c |\n| --- | --- |")
        XCTAssertEqual(coded, [
            .table(MarkdownTable(headers: ["`a|b`", "c"], alignments: [.leading, .leading], rows: [])),
        ])
    }

    func testOptionalOuterPipesAndOneHyphen() {
        XCTAssertEqual(
            Markdown.blocks("A | B | C\n--- | ---\n1 | 2 | 3"),
            [.table(MarkdownTable(headers: ["A", "B", "C"], alignments: [.leading, .leading, .leading], rows: [["1", "2", "3"]]))]
        )
        XCTAssertEqual(
            Markdown.blocks("| A | B\n--- | ---\n1 | 2 |"),
            [.table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]]))]
        )
        XCTAssertEqual(
            Markdown.blocks("| A | B |\n| - | - |\n| 1 | 2 |"),
            [.table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]]))]
        )
        XCTAssertEqual(
            Markdown.blocks("| A |\n| --- |\n| 1 |"),
            [.table(MarkdownTable(headers: ["A"], alignments: [.leading], rows: [["1"]]))]
        )
    }

    func testWhatIsNotATable() {
        XCTAssertEqual(Markdown.blocks("Pros | Cons\n---"), [.paragraph("Pros | Cons"), .rule])
        XCTAssertEqual(Markdown.blocks("Pros | Cons\n-"), [.paragraph("Pros | Cons -")])
        XCTAssertEqual(Markdown.blocks("Example: | A | B | |---|---| | 1 | 2 |"), [
            .paragraph("Example: | A | B | |---|---| | 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("| A | B | |---|---| then prose"), [
            .paragraph("| A | B | |---|---| then prose"),
        ])
        XCTAssertEqual(Markdown.blocks("| Step | --- | Done |"), [.paragraph("| Step | --- | Done |")])
        XCTAssertEqual(Markdown.blocks("| A \\| B | C | |---|---| | 1 | 2 |"), [
            .paragraph("| A \\| B | C | |---|---| | 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("```\n- [x] literal\n```"), [.code(language: nil, text: "- [x] literal")])
        XCTAssertEqual(Markdown.blocks("```\n- [x] literal"), [.code(language: nil, text: "- [x] literal")])
        XCTAssertEqual(Markdown.blocks("| A | B |\n| --- | --- |\n\n| 1 | 2 |"), [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [])),
            .paragraph("| 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter"), [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
            .paragraph("After"),
        ])
        XCTAssertEqual(Markdown.blocks("| A | B |\n| --- | --- |\n| 1 | 2 |\n- [x] done"), [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
            .task(indent: 0, number: nil, checked: true, text: "done"),
        ])
        XCTAssertEqual(
            Markdown.blocks("    | A | B |\n    | --- | --- |\n    | 1 | 2 |"),
            [.paragraph("| A | B | | --- | --- | | 1 | 2 |")]
        )
        XCTAssertEqual(Markdown.blocks("- intro\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |"), [
            .bullet(indent: 0, text: "intro"),
            .paragraph("| A | B | | --- | --- | | 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("- parent\n  - child\n  | A | B |\n  | - | - |"), [
            .bullet(indent: 0, text: "parent"),
            .bullet(indent: 1, text: "child"),
            .paragraph("| A | B | | - | - |"),
        ])
        XCTAssertEqual(Markdown.blocks("> | A | B |\n> | --- | --- |\n> | 1 | 2 |"), [
            .quote("| A | B |"),
            .quote("| --- | --- |"),
            .quote("| 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("- [x] A | B\n--- | ---"), [
            .task(indent: 0, number: nil, checked: true, text: "A | B"),
            .paragraph("--- | ---"),
        ])
    }

    func testTasks() {
        XCTAssertEqual(Markdown.blocks("- [ ] open"), [.task(indent: 0, number: nil, checked: false, text: "open")])
        XCTAssertEqual(Markdown.blocks("* [x] done"), [.task(indent: 0, number: nil, checked: true, text: "done")])
        XCTAssertEqual(Markdown.blocks("+ [X] done"), [.task(indent: 0, number: nil, checked: true, text: "done")])
        XCTAssertEqual(Markdown.blocks("1. [ ] open"), [.task(indent: 0, number: 1, checked: false, text: "open")])
        XCTAssertEqual(Markdown.blocks("1) [ ] open"), [.task(indent: 0, number: 1, checked: false, text: "open")])
        XCTAssertEqual(Markdown.blocks("  - [x] nested"), [.task(indent: 1, number: nil, checked: true, text: "nested")])
        XCTAssertEqual(Markdown.blocks("- [ ] parent\n  - [x] child"), [
            .task(indent: 0, number: nil, checked: false, text: "parent"),
            .task(indent: 1, number: nil, checked: true, text: "child"),
        ])
        XCTAssertEqual(Markdown.blocks("- [ ]"), [.task(indent: 0, number: nil, checked: false, text: "")])
        XCTAssertEqual(Markdown.blocks("- [x]no-space"), [.bullet(indent: 0, text: "[x]no-space")])
        XCTAssertEqual(Markdown.blocks("- [  ] no"), [.bullet(indent: 0, text: "[  ] no")])
    }

    func testAListItemOrTabIsNotADelimiter() {
        XCTAssertEqual(Markdown.blocks("| A | B |\n- | --- | --- |\n| 1 | 2 |"), [
            .paragraph("| A | B |"),
            .bullet(indent: 0, text: "| --- | --- |"),
            .paragraph("| 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("| A | B |\n\t| --- | --- |\n| 1 | 2 |"), [
            .paragraph("| A | B | | --- | --- | | 1 | 2 |"),
        ])
        XCTAssertEqual(Markdown.blocks("- intro\n  > note\n  | A | B |\n  | --- | --- |"), [
            .bullet(indent: 0, text: "intro"),
            .quote("note"),
            .paragraph("| A | B | | --- | --- |"),
        ])
    }

    func testShortWeldedDelimiterIsPadded() {
        XCTAssertEqual(Markdown.blocks("| A | B | |---| | 1 | 2 |"), [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
        ])
    }

    func testBracketSpaceIsNotACheckboxAndAQuotedTaskStaysAQuote() {
        XCTAssertEqual(Markdown.blocks("- [ x ] no"), [.bullet(indent: 0, text: "[ x ] no")])
        XCTAssertEqual(Markdown.blocks("> - [x] done"), [.quote("- [x] done")])
    }

    func testTokensSurviveEveryPrefix() {
        let sources = [
            "Lead-in prose\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter": ["Lead-in prose", "After", "1", "2"],
            "| -5% | 12:30 | $3 | x |\n| --- | --- | --- | --- |\n| a | b | c | d |": ["-5%", "12:30", "$3", "x", "a"],
            "- [x] next": ["next"],
        ]
        for (source, tokens) in sources {
            for length in 1...source.count {
                let partial = String(source.prefix(length))
                let shown = Markdown.blocks(partial).map(MarkdownTableTests.payload).joined(separator: "\n")
                for token in tokens where partial.contains(token) {
                    XCTAssertTrue(shown.contains(token), "lost \(token) from \(partial.debugDescription)")
                }
            }
        }
    }

    private static func payload(_ block: MarkdownBlock) -> String {
        switch block {
        case let .paragraph(text), let .bullet(_, text), let .quote(text), let .heading(_, text):
            return text
        case let .ordered(_, number, text):
            return "\(number). \(text)"
        case let .task(_, number, _, text):
            return (number.map { "\($0). " } ?? "") + text
        case let .code(_, text):
            return text
        case .rule:
            return ""
        case let .table(table):
            return (table.headers + table.rows.flatMap { $0 }).joined(separator: "\n")
        }
    }

    func testOneToThreeSpaceIndentIsATable() {
        let blocks = Markdown.blocks("  | A | B |\n  | --- | --- |\n  | 1 | 2 |")
        XCTAssertEqual(blocks, [
            .table(MarkdownTable(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
        ])
    }

    func testSpecialCharactersSurviveInCells() {
        let blocks = Markdown.blocks("| -5% | 12:30 | $3 | x |\n| --- | --- | --- | --- |\n| a | b | c | d |")
        XCTAssertEqual(blocks, [
            .table(MarkdownTable(
                headers: ["-5%", "12:30", "$3", "x"],
                alignments: [.leading, .leading, .leading, .leading],
                rows: [["a", "b", "c", "d"]]
            )),
        ])
    }
}
