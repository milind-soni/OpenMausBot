// Bot replies, rendered.
//
// `Markdown.blocks` does the splitting; this draws each block and hands the
// inline run to Foundation, which knows emphasis, code spans, strikethrough
// and links. SwiftUI makes the links tappable on its own, which is most of
// why this is worth doing at all — a reply full of sources was previously a
// wall of bracketed URLs.
//
// Only bot messages get this. The desktop makes the same split: what you
// typed is shown as you typed it, because markdown you did not intend is
// worse than markdown you did.
import SwiftUI
import UIKit
import CompanionCore

private struct OptionalIdentifier: ViewModifier {
    let identifier: String?

    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}

struct MarkdownText: View {
    let source: String
    /// Draws a caret after the last block. The streaming bubble sets this so
    /// the live reply and the settled one are the same view with the same
    /// layout — a caret bolted on outside would put it on its own line the
    /// moment the reply ends in a list item.
    var caret: Bool = false
    /// Identifier for the first table's horizontal scroll view. Settled
    /// bubbles pass `message-<id>-scroll`. Streaming and file preview pass nil.
    var scrollIdentifier: String? = nil
    var openLink: ((URL) -> OpenURLAction.Result)?

    init(
        source: String,
        caret: Bool = false,
        scrollIdentifier: String? = nil,
        openLink: ((URL) -> OpenURLAction.Result)? = nil
    ) {
        self.source = source
        self.caret = caret
        self.scrollIdentifier = scrollIdentifier
        self.openLink = openLink
    }

    var body: some View {
        let blocks = Markdown.blocks(source)
        VStack(alignment: .leading, spacing: 8) {
            let firstTable = blocks.firstIndex { if case .table = $0 { return true }; return false }
            ForEach(Array(blocks.enumerated()), id: \.offset) { item in
                view(
                    for: item.element,
                    tail: caret && item.offset == blocks.count - 1,
                    scrollIdentifier: item.offset == firstTable ? scrollIdentifier : nil
                )
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            openLink?(url) ?? .systemAction(url)
        })
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock, tail: Bool, scrollIdentifier: String?) -> some View {
        switch block {
        case let .paragraph(text):
            inline(text, tail: tail)
                .font(.system(size: 17))
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            // Three sizes, not six. A chat bubble is not a document, and an
            // h4 that looks exactly like body text is a heading that failed.
            inline(text, tail: tail)
                .font(.system(size: level <= 1 ? 21 : level == 2 ? 19 : 17, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)

        case let .bullet(indent, text):
            marker("•", indent: indent, text: text, tail: tail)

        case let .ordered(indent, number, text):
            marker("\(number).", indent: indent, text: text, tail: tail)

        case let .task(indent, number, checked, text):
            taskRow(indent: indent, number: number, checked: checked, text: text, tail: tail)

        case let .table(table):
            tableView(table, tail: tail, scrollIdentifier: scrollIdentifier)

        case let .quote(text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                inline(text, tail: tail)
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            VStack(alignment: .leading, spacing: 4) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.secondary)
                }
                // Horizontal scroll rather than wrapping: wrapped code is
                // harder to read than code you have to push sideways, and
                // indentation is most of what a snippet is saying.
                ScrollView(.horizontal, showsIndicators: false) {
                    (Text(text) + caretText(tail))
                        .font(.system(size: 14, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.secondary.opacity(0.14))
            )

        case .rule:
            Divider().padding(.vertical, 2)
        }
    }

    private func taskRow(indent: Int, number: Int?, checked: Bool, text: String, tail: Bool) -> some View {
        let state = String(localized: checked ? "completed" : "not completed")
        let words = renderedInline(text)
        let label = words.isEmpty ? state : "\(state), \(words)"
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let number {
                Text("\(number).")
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
                    .frame(minWidth: 16, alignment: .trailing)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
                inline(text, tail: tail).font(.system(size: 17))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
        }
        .padding(.leading, CGFloat(indent) * 14)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func tableView(_ table: MarkdownTable, tail: Bool, scrollIdentifier: String?) -> some View {
        let widths = columnWidths(table)
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(table.headers.enumerated()), id: \.offset) { index, header in
                        cell(
                            header,
                            width: widths[index],
                            alignment: table.alignments[index],
                            weight: .semibold,
                            tail: tail && table.rows.isEmpty && index == table.headers.count - 1,
                            identifier: scrollIdentifier.map { "\($0)-cell-0-\(index)" }
                        )
                    }
                }
                if !table.headers.isEmpty {
                    Divider().gridCellColumns(table.headers.count)
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { index, value in
                            let isLast = rowIndex == table.rows.count - 1 && index == row.count - 1
                            cell(
                                value,
                                width: widths[index],
                                alignment: table.alignments[index],
                                weight: .regular,
                                tail: tail && isLast,
                                identifier: scrollIdentifier.map { "\($0)-cell-\(rowIndex + 1)-\(index)" }
                            )
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .background(alignment: .topLeading) {
            if let scrollIdentifier {
                Color.white.opacity(0.001)
                    .frame(width: 12, height: 12)
                    .accessibilityIdentifier(scrollIdentifier)
            }
        }
    }

    private func cell(
        _ text: String,
        width: CGFloat,
        alignment: MarkdownTableAlignment,
        weight: Font.Weight,
        tail: Bool,
        identifier: String?
    ) -> some View {
        Color.clear
            .frame(width: tail ? width + caretWidth : width, height: 22)
            .overlay(alignment: frameAlignment(alignment)) {
                inline(text, tail: tail)
                    .font(.system(size: 15, weight: weight))
                    .lineLimit(1)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(renderedInline(text))
            .modifier(OptionalIdentifier(identifier: identifier))
    }

    private func frameAlignment(_ alignment: MarkdownTableAlignment) -> Alignment {
        switch alignment {
        case .leading: .leading
        case .trailing: .trailing
        case .center: .center
        }
    }

    /// Column width is the widest single-line cell, measured on the words
    /// that are actually drawn. A code span is also measured in monospace,
    /// which is wider than the proportional font.
    private func columnWidths(_ table: MarkdownTable) -> [CGFloat] {
        let headerFont = UIFont.systemFont(ofSize: 15, weight: .semibold)
        let bodyFont = UIFont.systemFont(ofSize: 15, weight: .regular)
        return table.headers.indices.map { index in
            var widest = textWidth(table.headers[index], font: headerFont)
            for row in table.rows where index < row.count {
                widest = max(widest, textWidth(row[index], font: bodyFont))
            }
            return max(widest + 8, 24)
        }
    }

    private var caretWidth: CGFloat {
        textWidth("\u{2007}▍", font: UIFont.systemFont(ofSize: 15))
    }

    private func textWidth(_ text: String, font: UIFont) -> CGFloat {
        let plain = renderedInline(text)
        var width = ceil((plain as NSString).size(withAttributes: [.font: font]).width)
        if text.contains("`") {
            let mono = UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
            width = max(width, ceil((plain as NSString).size(withAttributes: [.font: mono]).width))
        }
        return width
    }

    /// The words VoiceOver should hear, with inline markers removed. The
    /// visible text still goes through Foundation so emphasis stays styled.
    private func renderedInline(_ text: String) -> String {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return String(attributed.characters)
        }
        return text
    }

    private func marker(_ symbol: String, indent: Int, text: String, tail: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(symbol)
                .font(.system(size: 17))
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 16, alignment: .trailing)
            inline(text, tail: tail).font(.system(size: 17))
        }
        .padding(.leading, CGFloat(indent) * 14)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Inline markdown via Foundation. `.inlineOnlyPreservingWhitespace`
    /// because the blocks are already split — asking for `.full` here would
    /// have it re-interpret list markers this has already consumed.
    ///
    /// Falling back to the raw string on a parse failure is the point: a
    /// half-typed link mid-stream should show as the characters the model has
    /// sent so far, not vanish until it closes the bracket.
    private func inline(_ text: String, tail: Bool = false) -> Text {
        let rendered: Text
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            rendered = Text(attributed)
        } else {
            rendered = Text(text)
        }
        return rendered + caretText(tail)
    }

    /// A figure space then a block, so the caret sits off the last glyph
    /// rather than touching it. Empty when not streaming — an empty `Text`
    /// concatenated in costs nothing and keeps the callers branch-free.
    private func caretText(_ tail: Bool) -> Text {
        tail ? Text("\u{2007}▍").foregroundStyle(Color.secondary) : Text("")
    }
}
