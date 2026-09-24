# Issue 1706 — design

## Decision

Teach `Markdown.blocks` to emit a table block and a task block. `MarkdownText`
draws both. `TextBubble` stops replacing a whole-message pipe table with
`SQLResultTableView`, and that view is deleted. Walkie skips a delimiter row
and checkbox brackets when it speaks.

Android keeps today's card. That copy is #1707.

## Blocks

`MarkdownBlock` gains two cases. Existing cases stay as they are, so current
`.bullet(indent:text:)` call sites still compile.

```swift
public enum MarkdownTableAlignment: Equatable, Sendable {
    case leading, trailing, center
}

public struct MarkdownTable: Equatable, Sendable {
    public var headers: [String]
    public var alignments: [MarkdownTableAlignment]
    public var rows: [[String]]
}

case table(MarkdownTable)
case task(indent: Int, number: Int?, checked: Bool, text: String)
```

Invariant: `alignments.count == headers.count`, and every row has that same
count. Short rows are padded with `""`. A multiline body row with extra cells
widens the header with `""` and alignment `.leading`. A welded body is split
into rows of the header width before the struct exists, so a leftover cell
starts the next row. The delimiter row is not stored.

## When a table starts

A table row is recognized only when its leading whitespace is 0–3 spaces and
contains no tab. Four spaces or a leading tab stays text. The parser keeps a
stack of open list-marker indents. A blank line clears the stack. A later line
is under a list when its leading whitespace is greater than the innermost
marker. Those lines are not tables: a nested marker is pushed, and a pipe line
stays visible text. A line that is not more indented than the innermost marker
pops markers until one still contains it, then parses on its own. So
`- parent`, a nested `- child`, and a pipe line indented with the child stay
text, while a table at column 0 after a list item is still a table. A
top-level table indented 1–3 spaces is a table because the stack is empty.
A header candidate uses the same exclusions as a body row: it is not a
heading, quote, fence, rule, or list item. `- [x] A | B` followed by a
delimiter is a task, not a table.

A delimiter row contains at least one `|` and, after the outer empty edge
cells are dropped, at least one cell, every one of which is a delimiter cell.
A lone `|` is not a delimiter row. `Pros | Cons` followed by `-` is one
paragraph, `Pros | Cons -`, because the soft break joins them and `-` is not
a bullet or a rule.

After the existing fence, blank-line, rule, heading, and quote checks, and
before list items:

1. **One welded line.** The shape is the desktop rescue in `splitInlineTable`,
   plus the backtick and backslash refusal that `repairMarkdownTables` applies
   to a whole paragraph. `splitInlineTable` itself does not look at backticks.
   After at most three spaces the line starts with `|`, contains no backtick
   and no backslash, contains a delimiter run, the header has at least two
   cells and ends with `|`, and the remainder is empty or starts with `|`.
   The following line must not itself be a delimiter row. `Example: | A | B | |---|---| | 1 | 2 |`,
   `| A | B | |---|---| then prose`, and `| Step | --- | Done |` stay
   paragraphs. A welded body cell past the header width starts the next row,
   padded with an empty cell. Exactly one empty cell at a row boundary is the
   join. A real empty cell inside a row stays. A following pipe row that is
   not indented under a list continues the same table. A blank line ends it,
   same as the header-plus-delimiter path, so sample 2's delimiter lines stay
   paragraphs.
2. **Header plus delimiter.** If this line is a top-level row and the next
   line is a top-level delimiter row, end the paragraph in progress and emit
   a table. A delimiter whose cell count differs from the header is fitted to
   the header width: supplied alignment is kept, missing cells are `---`,
   extra cells are dropped. Plain dashes are leading alignment, including
   cells synthesized to pad a short delimiter. Body lines continue while they
   are top-level rows. A multiline body cell past the header width grows the
   table with an empty header. A blank line ends the table. A line that is
   not a body row is not consumed: the outer loop reparses it, so `After` is
   a paragraph and `- [x] done` is a task.

A body row is a top-level line that contains `|`, still has at least one cell
after the outer empty edges are dropped, and does not itself start a heading,
quote, fence, rule, or list item. A line such as `- a | b` therefore ends the
table. Cells split on `|` that is not escaped and not inside a backtick span.
A leading or trailing empty cell created by an outer pipe is dropped. Middle
empty cells stay. `\|` becomes a literal pipe, including inside a code span
the same way the current `tableCells` helper does. Any other backslash is
kept.

A delimiter cell, after trimming, matches `^:?-+:?$`. Alignment is `trailing`
when the cell ends with `:` and does not start with one, `center` when it
does both, and `leading` otherwise. One hyphen is enough, matching GFM and
`DELIMITER_CELL` in `src/lib/markdown-tables.ts`. The old card required
three hyphens; that stricter check goes away with the card. A short delimiter
is padded and a long one is trimmed to the header width even when a cell
contains `\|` or a code span. Desktop's repair skips those paragraphs because
it is not a tokenizer. This parser fits them. The weld, which is not a
tokenizer either, still refuses a line that contains a backtick or a
backslash.

A line with an odd number of unescaped backticks is not a table. It stays a
paragraph, which is the streaming and inline-code failure mode that loses
nothing.

Fences are still consumed first, so an open fence runs to the end and the
pipes inside it are code. `---` alone is still a rule, because that check
runs before table detection. A pipe line with no delimiter after it is
appended to the paragraph.

This parser does not wait for a blank line before a table. Desktop
CommonMark will not interrupt a paragraph, and `repairMarkdownTables`
inserts the blank line so the table parses. Recognizing header-plus-delimiter
here has the same result without a second pass.

## Task items

`listItem` still recognizes `- `, `* `, `+ `, and ordered markers (`1. ` and
`1) `). When the remainder matches `[ ]`, `[x]`, or `[X]` followed by
whitespace, or the checkbox is the whole remainder, the block is `.task`.
The text is the trimmed remainder. An ordered task keeps its number beside
the checkbox. Whitespace after `]` is required, so `- [x]no-space` stays
`.bullet`. `[  ]` and `[ x ]` are not checkboxes. Nesting depth stays
`min(leading / 2, 4)`.

## Drawing

`MarkdownText` gains an optional `scrollIdentifier`. The first table in that
view puts it on its horizontal `ScrollView`. `TextBubble` passes
`message-<message id>-scroll`. Streaming and file preview pass nil. The
method that switches on blocks stays `view(for:tail:)`.

A table is one `Grid` inside that scroll view: header, a divider that spans
every column, then body rows. There may be no body rows. Each column's width
is the widest single-line cell in that column. Every cell uses that width,
`lineLimit(1)`, and the column's alignment (`leading`, `trailing`, or
`center`) on both header and body, so the accessibility frame is the column
rather than the text's own width. Cell text goes through the existing
`inline` helper. The caret sits on the last cell, including a padded empty one. The table
stays inside the speech bubble.

A task row shows the ordered number, when it has one, as its own text
`"\(number)."` outside the task's accessibility element. Both `1.` and `1)`
use that format. The checkbox image and the words are one element, not a
button, with children ignored. Its label is `completed` or `not completed`,
then `, ` and the rendered inline text when that text is non-empty. The
catalog keys live in `ios/App/Localizable.xcstrings`: English `completed` /
`not completed`, Brazilian Portuguese `concluído` / `não concluído`. The
image is not a separate VoiceOver element, and no child label contains
`[x]` or `[ ]`. The caret uses the same `tail` the bullet row already takes.

`FilePreviewView` and `StreamingBubble` keep calling `MarkdownText`. They do
not grow a second splitter.

## Chat bubble

Delete `parsedTable`, `tableCells`, `isTableSeparator`, and the
`SQLResultTableView` branch in `TextBubble`. `customCard` stays true only
for `parsedDiff`, so a diff is still the git card and a table is a normal
bubble. Delete `ios/App/Cards/SQLResultTableView.swift`. Nothing else in the
iOS target references it.

User messages still take the `mine` branch and `Text`, not `MarkdownText`.

## Walkie

`Walkie.speakable` calls `Markdown.blocks` and speaks the blocks. It does not
keep a second weld. A table contributes one sentence per row, cells joined
with `", "`, empty cells omitted, using the same outer-edge drop as the
parser. The delimiter row is not stored, so it is not spoken. A paragraph is
dropped only when its whole text, after that same edge drop, is delimiter
cells. That is sample 2's `| :--- | ---: |`, `| - | - |`, and `--- | ---`.
A delimiter line buried inside a joined paragraph, such as the pipes under a
list item, is not a separate line anymore and is spoken with that paragraph.
Any other paragraph that contains `|` is spoken as its cells joined with
`", "`. Headings, lists, quotes, and paragraphs still run through the
existing inline stripping, so today's Walkie tests stay true. A task is
spoken as its text only: the number and the checkbox token are not spoken,
and a bare letter `x` in a cell is. A fenced code block is still
"Code omitted." The 600-character default and the 400-character call from
`WalkieView` stay.

## Master text

Add this section to `docs/ios-companion.md` after "Current status". It
states the current behavior and does not mention an issue number.

```markdown
## Markdown

Bot and room replies are rendered. Messages the person typed stay literal.

Rendered blocks are paragraphs, headings, lists, task lists, quotes,
thematic rules, fenced code, and tables. Inline emphasis, code,
strikethrough, and links use Foundation attributed text. A table scrolls
horizontally inside the bubble. A task item shows a checkbox.

A top-level pipe table, indented by at most three spaces, is a table. A table
inside a list item, a blockquote, or a fence stays text or code, as does a
row indented by four spaces or a tab. The in-app spoken form reads each table
row and each task's words, and it skips a delimiter-only line and the
checkbox token. Closed-app voice is unchanged.
```

The existing "Markdown rendering" bullet in Current status stays. It is
still true.

## Impact

| What changes | Where | Kind | Response |
|---|---|---|---|
| `Markdown.blocks`, new `MarkdownTable` / `.table` / `.task` | `ios/Sources/CompanionCore/Markdown.swift` | Behavior of every bot bubble and Markdown preview | Implement here, including list-indent memory and the unconsumed table terminator. |
| Exhaustive switches | `MarkdownText.view(for:tail:)`, `MarkdownTests.text` | Compile break if a case is missing | Add both cases. The task case passes `tail`. |
| `TextBubble.parsedTable`, `tableCells`, `isTableSeparator` | `ios/App/ChatView.swift` | Whole-message tables change from the SQL card to a bubble table | Delete them. Diff card stays. Pass `message-<id>-scroll` into `MarkdownText`. |
| `MessageRow` | `ios/App/ChatView.swift` | Preview queries need a container | `accessibilityElement(children: .contain)` and identifier `message-<id>`. Children stay separate. Copy and Select Text stay on `attachedContent.text`. |
| `SQLResultTableView` | `ios/App/Cards/SQLResultTableView.swift` | Dead after the branch goes | Delete the file. The `Copy CSV` catalog entry may remain unused. |
| Task words | `ios/App/Localizable.xcstrings` | New strings | English `completed` / `not completed`. Portuguese `concluído` / `não concluído`. |
| `MarkdownText` callers | `StreamingBubble`, `FilePreviewView` | They show tables through the same view | Pass no scroll identifier. No second splitter. |
| `Walkie.speakable` | `Walkie.swift`, read by `WalkieView` and `WalkieController` | Spoken tables and tasks | Speak `Markdown.blocks`. Do not change the length caps. |
| Preview fixture | `ios/App/ThreadPreview.json` only | UI fixture | Parent chain in the requirements. Do not edit `ImagePreview.json` or `ThreadPreviewPages.json`. |
| UI assertions | `ThreadNavigationUITests` | CI already runs this class | Add the acceptance 14 checks here, not in a new class. |
| Android comments | `Transcript.kt`, `TranscriptTest.kt`, `ExecutionFeedbackTest.kt`, `TableReadingOrderTest.kt`, `TranscriptCardViews.kt` | Comments will name a deleted file | Describe Android's own card and point at #1707. No Kotlin behavior change. Do not edit `Markdown.kt`. |

Not affected:

- User-message `Text` in `TextBubble`. It never calls `Markdown.blocks`. The new identifier still wraps that row.
- `parsedDiff` / `GitPRDiffCardView`. A message that is only a diff still takes that card.
- Desktop `src/lib/markdown-tables.ts` and `ChatMarkdown.tsx`. No shared code.
- Server, sidecar, and fixtures under `ios/Tests/CompanionCoreTests/Fixtures`. The wire payload does not change.
- Widgets and roster previews. They show a short plain line.
- Message search snippets and the held-send preview. They stay raw source.
- `android/.../Markdown.kt`. It does not cite the deleted Swift file.

The means check: `Markdown.blocks` is consumed by `MarkdownText` and by `Walkie.speakable`. The scroll identifier is consumed only by the first table inside `MarkdownText`. The message identifier is consumed by the preview UI test.

## Tests

`MarkdownTests` covers acceptances 1 through 10: both prose-and-table
strings, welded empty cells, the short tail, multiline growth, welded wrap,
short and long delimiters, center `:---:`, optional outer pipes, one hyphen,
one column, `Pros | Cons\n-` as one paragraph, the weld negatives, fences
including an open fence and a fenced `- [x] literal`, a blank line, a table
then `After`, a table then a task, four spaces, a tab, a list continuation,
a quote, a 1–3 space top-level table, and every task row in acceptance 9.
The streaming check is a new test, not an extension of
`testNoPrefixOfAReplyLosesCharacters`. It walks every prefix of those sources
plus the `-5%` / `12:30` / `$3` / `x` row. The expected string is written by
hand for the full source, and each prefix is checked against the same hand
rule: drop structure only where the parser consumed it, and do not strip `-`,
`:`, or `$` just because of their character class. Whitespace the parser
joins with a single space is normalized to that space. `Quant baskets` must
not collapse to `Quantbaskets`.

`WalkieTests` locks both exact spoken strings.

Mutations, each failing the named test, recorded before commit:

| Mutation | Fails |
|---|---|
| Do not emit `.table` | An acceptance 1 table assertion |
| Do not emit `.task` | The `+ [X]` row and the nested parent/child row |
| Treat `Pros \| Cons` followed by `-` as a table | Acceptance 5 |
| Split the pipe inside a code span | Acceptance 4 |
| Leave a delimiter row or a checkbox `x` in speech | Acceptance 11's first string |
| Treat `:---:` as leading | Acceptance 4's center column |
| Grow a third column on the welded extra cell | Acceptance 3's wrap |

UI, inside `ThreadNavigationUITests`, so the existing CI selection runs it.
Launch with `-store-preview -threads-preview` and without `-images-preview`.
Do not edit `ImagePreview.json`. The `ThreadPreview.json` chain is
`preview-gmail-user` → `preview-gmail-grid` → `preview-gmail-tasks` →
`preview-gmail-user-md` → `preview-gmail-reply`, and `activeLeafId` stays
`preview-gmail-reply`. Queries stay inside `message-<id>`. The grid checks
cell order, shared center lines, column widths, the long token's height,
a left swipe that moves it, VoiceOver order, and the absence of `DATA TABLE`,
`Copy CSV`, `rows`, and `| --- | --- |`. The tasks message checks
`Quant baskets`, `1.`, `completed, Ship the notes` (not a button), and
`not completed, waiting`. The user message still shows its delimiter and
`[x] done`. Attach a screenshot. Existing navigation and composer tests still
pass. Restoring `parsedTable` fails the grid checks. The same class runs on
the CI iPad destination as well as the phone.

## Verification

From `ios/`:

```sh
swift test
```

Then generate the project and run the UI test on a fresh simulator, the
way `docs/verification/ios-threads.md` describes. Also build
`OpenMausCompanion` for the simulator.

`docs/verification/README.md` and the fake-engine control tool cover server
flows. This change does not touch them, so that harness is not the check.

Android unit tests stay in CI. They must still pass, because only comments
change. Kotlin behavior does not.
